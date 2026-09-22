/* Person ROI lock: full-frame acquire → frozen padded crop for inference. */
(function (root) {
    const ACQUIRE_FRAMES = 4;
    const ROI_PAD_X = 0.4;
    const ROI_PAD_Y_TOP = 0.48;
    const ROI_PAD_Y_BOTTOM = 0.28;
    const CENTER_FOLLOW_ALPHA = 0.18;
    const LOST_MS = 800;
    const TRACK_INDICES = [11, 12, 13, 14, 15, 16, 23, 24];

    let state = {
        phase: 'acquiring',
        stableFrames: 0,
        frozenWidth: null,
        frozenHeight: null,
        centerX: null,
        centerY: null,
        graceStartedAt: null,
        repHardLock: false,
    };

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function resetPosePersonRoi() {
        state = {
            phase: 'acquiring',
            stableFrames: 0,
            frozenWidth: null,
            frozenHeight: null,
            centerX: null,
            centerY: null,
            graceStartedAt: null,
            repHardLock: false,
        };
    }

    function setPoseRoiRepHardLock(active) {
        state.repHardLock = Boolean(active);
    }

    function bodyBoxFromLandmarks(landmarks, minConfidence) {
        if (!landmarks?.length) return null;
        let minX = 1;
        let minY = 1;
        let maxX = 0;
        let maxY = 0;
        let count = 0;
        for (const index of TRACK_INDICES) {
            const lm = landmarks[index];
            if (!lm) continue;
            const vis = Math.min(
                Number(lm.visibility ?? 1),
                Number(lm.presence ?? 1)
            );
            if (!Number.isFinite(vis) || vis < minConfidence) continue;
            minX = Math.min(minX, lm.x);
            minY = Math.min(minY, lm.y);
            maxX = Math.max(maxX, lm.x);
            maxY = Math.max(maxY, lm.y);
            count += 1;
        }
        if (count < TRACK_INDICES.length) return null;
        const width = maxX - minX;
        const height = maxY - minY;
        if (width < 0.05 || height < 0.08) return null;
        return {
            minX,
            minY,
            maxX,
            maxY,
            width,
            height,
            centerX: (minX + maxX) / 2,
            centerY: (minY + maxY) / 2,
        };
    }

    function paddedCropFromBox(box) {
        const padX = box.width * ROI_PAD_X;
        const padTop = box.height * ROI_PAD_Y_TOP;
        const padBottom = box.height * ROI_PAD_Y_BOTTOM;
        const x = clamp(box.minX - padX, 0, 1);
        const y = clamp(box.minY - padTop, 0, 1);
        const right = clamp(box.maxX + padX, 0, 1);
        const bottom = clamp(box.maxY + padBottom, 0, 1);
        const w = Math.max(0.12, right - x);
        const h = Math.max(0.2, bottom - y);
        return {
            x,
            y,
            width: w,
            height: h,
            centerX: x + w / 2,
            centerY: y + h / 2,
        };
    }

    function boxesSimilar(a, b) {
        const centerDist = Math.hypot(a.centerX - b.centerX, a.centerY - b.centerY);
        const scale = Math.max(a.height, b.height, 0.001);
        const sizeRatio = a.width / Math.max(b.width, 0.001);
        const heightRatio = a.height / Math.max(b.height, 0.001);
        return (
            centerDist / scale < 0.35
            && sizeRatio > 0.75
            && sizeRatio < 1.35
            && heightRatio > 0.75
            && heightRatio < 1.35
        );
    }

    function landmarkConfidence(lm) {
        return Math.min(
            Number(lm.visibility ?? 1),
            Number(lm.presence ?? 1)
        );
    }

    function highestArmY(landmarks, minConfidence) {
        let highestY = Infinity;
        let count = 0;
        for (const index of [11, 12, 13, 14, 15, 16]) {
            const lm = landmarks[index];
            if (!lm || !Number.isFinite(lm.y)) continue;
            const vis = landmarkConfidence(lm);
            if (!Number.isFinite(vis) || vis < minConfidence * 0.75) continue;
            highestY = Math.min(highestY, lm.y);
            count += 1;
        }
        if (count === 0 || !Number.isFinite(highestY)) {
            return null;
        }
        return highestY;
    }

    function nudgeLockedCropForRaisedArms(landmarks, minConfidence) {
        if (state.phase !== 'locked' && state.phase !== 'grace') {
            return;
        }
        if (
            state.frozenHeight == null
            || !Number.isFinite(state.centerY)
            || !landmarks?.length
        ) {
            return;
        }
        const crop = getActivePersonCropNorm();
        if (!crop) {
            return;
        }
        const highestY = highestArmY(landmarks, minConfidence);
        if (highestY == null) {
            return;
        }
        const topMargin = state.frozenHeight * 0.18;
        const topEdge = crop.y + topMargin;
        if (highestY >= topEdge) {
            return;
        }
        const deficit = topEdge - highestY;
        const grow = Math.min(deficit * 1.2, 0.2);
        if (grow > 0.002) {
            state.frozenHeight = Math.min(0.98, state.frozenHeight + grow);
        }
        const shiftUp = deficit * 0.85;
        state.centerY = clamp(
            state.centerY - shiftUp,
            state.frozenHeight / 2,
            1 - state.frozenHeight / 2
        );
    }

    function updatePosePersonRoiFromLandmarks(landmarks, { minConfidence = 0.42, now = performance.now() } = {}) {
        const box = bodyBoxFromLandmarks(landmarks, minConfidence);
        if (!box) {
            if (state.phase === 'locked') {
                if (state.graceStartedAt == null) {
                    state.graceStartedAt = now;
                    state.phase = 'grace';
                } else if (now - state.graceStartedAt > LOST_MS) {
                    resetPosePersonRoi();
                    return { phase: 'lost', cropNorm: null };
                }
            }
            return { phase: state.phase, cropNorm: getActivePersonCropNorm() };
        }

        state.graceStartedAt = null;
        const crop = paddedCropFromBox(box);

        if (state.phase === 'acquiring') {
            if (state._lastAcquireBox && boxesSimilar(box, state._lastAcquireBox)) {
                state.stableFrames += 1;
            } else {
                state.stableFrames = 1;
            }
            state._lastAcquireBox = box;
            if (state.stableFrames >= ACQUIRE_FRAMES) {
                state.phase = 'locked';
                state.frozenWidth = crop.width;
                state.frozenHeight = crop.height;
                state.centerX = crop.centerX;
                state.centerY = crop.centerY;
                state._lastAcceptedBox = box;
            }
            return { phase: state.phase, cropNorm: null };
        }

        if (state.phase === 'locked' || state.phase === 'grace') {
            state.phase = 'locked';
            const followTarget = state._lastAcceptedBox && boxesSimilar(box, state._lastAcceptedBox)
                ? crop
                : null;
            if (followTarget) {
                if (Number.isFinite(state.centerX) && Number.isFinite(state.centerY)) {
                    state.centerX += (followTarget.centerX - state.centerX) * CENTER_FOLLOW_ALPHA;
                    state.centerY += (followTarget.centerY - state.centerY) * CENTER_FOLLOW_ALPHA;
                } else {
                    state.centerX = followTarget.centerX;
                    state.centerY = followTarget.centerY;
                }
                state._lastAcceptedBox = box;
            }
            nudgeLockedCropForRaisedArms(landmarks, minConfidence);
        }

        return { phase: state.phase, cropNorm: getActivePersonCropNorm() };
    }

    function getActivePersonCropNorm() {
        if (state.phase !== 'locked' && state.phase !== 'grace') {
            return null;
        }
        if (
            state.frozenWidth == null
            || state.frozenHeight == null
            || state.centerX == null
            || state.centerY == null
        ) {
            return null;
        }
        let x = state.centerX - state.frozenWidth / 2;
        let y = state.centerY - state.frozenHeight / 2;
        x = clamp(x, 0, 1 - state.frozenWidth);
        y = clamp(y, 0, 1 - state.frozenHeight);
        return {
            x,
            y,
            width: state.frozenWidth,
            height: state.frozenHeight,
        };
    }

    function getActivePersonCropPixels(videoWidth, videoHeight) {
        const norm = getActivePersonCropNorm();
        if (!norm || !videoWidth || !videoHeight) return null;
        return {
            x: Math.round(norm.x * videoWidth),
            y: Math.round(norm.y * videoHeight),
            width: Math.max(1, Math.round(norm.width * videoWidth)),
            height: Math.max(1, Math.round(norm.height * videoHeight)),
            norm,
        };
    }

    function shouldUseRoiCapture() {
        return state.phase === 'locked' || state.phase === 'grace';
    }

    function remapLandmarksFromCrop(landmarks, cropPixels, videoWidth, videoHeight) {
        if (!landmarks?.length || !cropPixels || !videoWidth || !videoHeight) {
            return landmarks;
        }
        const { x: cx, y: cy, width: cw, height: ch } = cropPixels;
        return landmarks.map((landmark) => ({
            ...landmark,
            x: (cx + landmark.x * cw) / videoWidth,
            y: (cy + landmark.y * ch) / videoHeight,
        }));
    }

    function drawPersonRoiDebug(canvasCtx, videoWidth, videoHeight) {
        const crop = getActivePersonCropPixels(videoWidth, videoHeight);
        if (!canvasCtx || !crop) return;
        const { width: canvasW, height: canvasH } = canvasCtx.canvas;
        const sx = (crop.x / videoWidth) * canvasW;
        const sy = (crop.y / videoHeight) * canvasH;
        const sw = (crop.width / videoWidth) * canvasW;
        const sh = (crop.height / videoHeight) * canvasH;
        canvasCtx.save();
        canvasCtx.strokeStyle = '#00ff88';
        canvasCtx.lineWidth = 2;
        canvasCtx.setLineDash([6, 4]);
        canvasCtx.strokeRect(sx, sy, sw, sh);
        canvasCtx.fillStyle = 'rgba(0, 255, 136, 0.85)';
        canvasCtx.font = '12px monospace';
        canvasCtx.fillText(
            `POSE LOCK: ${state.phase.toUpperCase()}  ROI ${crop.width}x${crop.height}`,
            sx + 4,
            Math.max(14, sy - 6)
        );
        canvasCtx.restore();
    }

    function getPosePersonRoiState() {
        return { ...state, cropNorm: getActivePersonCropNorm() };
    }

    root.resetPosePersonRoi = resetPosePersonRoi;
    root.setPoseRoiRepHardLock = setPoseRoiRepHardLock;
    root.updatePosePersonRoiFromLandmarks = updatePosePersonRoiFromLandmarks;
    root.getActivePersonCropPixels = getActivePersonCropPixels;
    root.shouldUseRoiCapture = shouldUseRoiCapture;
    root.remapLandmarksFromCrop = remapLandmarksFromCrop;
    root.drawPersonRoiDebug = drawPersonRoiDebug;
    root.getPosePersonRoiState = getPosePersonRoiState;
})(globalThis);
