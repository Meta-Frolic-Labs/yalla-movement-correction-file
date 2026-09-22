(function exposePoseContinuity(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.createPoseContinuityTracker = api.createPoseContinuityTracker;
}(typeof globalThis !== 'undefined' ? globalThis : window, function buildPoseContinuity() {
    function createPoseContinuityTracker({
        landmarkConfidence = 0.48,
        reacquireFrames = 3,
        getConfidence = (landmark) => landmark?.visibility ?? 1,
        isRepHardLocked = () => false,
        onReset = () => {}
    } = {}) {
        let lockedDescriptor = null;
        let reacquireCandidate = null;
        let reacquireStreak = 0;

        function midpoint(a, b) {
            return {
                x: (a.x + b.x) / 2,
                y: (a.y + b.y) / 2
            };
        }

        function distance(a, b) {
            return Math.hypot(a.x - b.x, a.y - b.y);
        }

        function descriptor(landmarks) {
            const required = [11, 12, 23, 24];
            if (!required.every((index) => (
                index < (landmarks?.length || 0)
                && getConfidence(landmarks[index]) >= landmarkConfidence
            ))) {
                return null;
            }
            const shoulderMid = midpoint(landmarks[11], landmarks[12]);
            const hipMid = midpoint(landmarks[23], landmarks[24]);
            return {
                centerX: (shoulderMid.x + hipMid.x) / 2,
                centerY: (shoulderMid.y + hipMid.y) / 2,
                torsoLength: distance(shoulderMid, hipMid)
            };
        }

        function descriptorsPlausible(current, previous) {
            if (!current || !previous) return false;
            const centerDistance = Math.hypot(
                current.centerX - previous.centerX,
                current.centerY - previous.centerY
            );
            const normalizedCenterJump =
                centerDistance / Math.max(previous.torsoLength, 0.001);
            const torsoRatio =
                current.torsoLength / Math.max(previous.torsoLength, 0.001);
            return (
                normalizedCenterJump < 1.45
                && torsoRatio > 0.45
                && torsoRatio < 2.1
            );
        }

        function updateCandidate(current) {
            if (
                reacquireCandidate
                && descriptorsPlausible(current, reacquireCandidate)
            ) {
                reacquireStreak += 1;
            } else {
                reacquireCandidate = { ...current };
                reacquireStreak = 1;
            }
        }

        function commit(current) {
            lockedDescriptor = { ...current };
            reacquireCandidate = null;
            reacquireStreak = 0;
            return true;
        }

        function accepts(landmarks) {
            const current = descriptor(landmarks);
            if (!current) return false;

            if (!lockedDescriptor) {
                updateCandidate(current);
                return reacquireStreak >= reacquireFrames
                    ? commit(current)
                    : false;
            }

            if (descriptorsPlausible(current, lockedDescriptor)) {
                return commit(current);
            }

            updateCandidate(current);
            const requiredFrames = isRepHardLocked()
                ? reacquireFrames * 2
                : reacquireFrames;
            return reacquireStreak >= requiredFrames
                ? commit(current)
                : false;
        }

        function reset() {
            lockedDescriptor = null;
            reacquireCandidate = null;
            reacquireStreak = 0;
            onReset();
        }

        return Object.freeze({ accepts, reset });
    }

    return { createPoseContinuityTracker };
}));
