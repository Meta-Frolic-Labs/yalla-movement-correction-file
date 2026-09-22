/* Opt-in, bounded timing capture. No images or landmarks are exported. */
(function (root) {
    function createPoseDiagnostics(search, clock = performance) {
        if (new URLSearchParams(search).get('poseDebug') !== '1') return null;
        const limit = 600;
        let startedAt = null;
        let stoppedAt = null;
        let nextId = 0;
        let lastResultId = 0;
        let lastPresentedFrames = null;
        let previousLandmarks = null;
        let previousDisplayLandmarks = null;
        const counts = {};
        const samples = {};
        const frames = new Map();
        const events = [];
        const settings = {};
        const epoch = () => clock.timeOrigin + clock.now();
        function active() {
            if (startedAt === null) startedAt = clock.now();
            if (stoppedAt === null && clock.now() - startedAt >= 300000) {
                stoppedAt = startedAt + 300000;
            }
            return stoppedAt === null;
        }
        function count(name, amount = 1) {
            if (active()) counts[name] = (counts[name] || 0) + amount;
        }
        function sample(name, value) {
            if (!active() || !Number.isFinite(value) || value < 0) return;
            const values = samples[name] || (samples[name] = []);
            values.push(value);
            if (values.length > limit) values.shift();
        }
        function event(type, details = {}) {
            if (!active()) return;
            events.push({ type, at: epoch(), ...details });
            if (events.length > limit) events.shift();
        }
        function begin(timestampMs, metadata) {
            if (!active()) return undefined;
            const trace = {
                id: ++nextId,
                observedAt: clock.timeOrigin + timestampMs,
                mediaTime: metadata?.mediaTime ?? null,
                // Usually unavailable for local getUserMedia. Never substitute
                // a callback timestamp for a sensor capture timestamp.
                cameraAt: Number.isFinite(metadata?.captureTime)
                    ? clock.timeOrigin + metadata.captureTime : null,
                conversionStartedAt: epoch(),
            };
            frames.set(trace.id, trace);
            if (frames.size > limit) frames.delete(frames.keys().next().value);
            return trace;
        }
        function received(trace, hasPose, landmarks) {
            count('resultCallbacks');
            if (hasPose) count('resultsWithPose');
            // A motion metric, interpreted as jitter ONLY during a static test.
            // Keep one previous pose in memory, never include coordinates in exports.
            if (active()) {
                let squaredStep = 0;
                let joints = 0;
                for (let i = 11; landmarks && previousLandmarks && i < landmarks.length; i++) {
                    const current = landmarks[i];
                    const previous = previousLandmarks[i];
                    if (previous && (current.visibility ?? 1) >= 0.5 && (previous.visibility ?? 1) >= 0.5) {
                        squaredStep += (current.x - previous.x) ** 2 + (current.y - previous.y) ** 2;
                        joints++;
                    }
                }
                if (joints) sample('landmarkStepRmsNormalized', Math.sqrt(squaredStep / joints));
                previousLandmarks = landmarks?.map(({ x, y, visibility }) => ({ x, y, visibility })) ?? null;
            }
            if (!trace || !active() || !frames.has(trace.id)) return;
            const record = frames.get(trace.id);
            Object.assign(record, trace, { receivedAt: epoch() });
            if (trace.id <= lastResultId) count('outOfOrderOrDuplicateResults');
            lastResultId = Math.max(lastResultId, trace.id);
            sample('conversionMs', record.submittedAt - record.conversionStartedAt);
            sample('captureMs', record.captureMs);
            sample('workerDispatchMs', record.inferenceStartedAt - record.submittedAt);
            sample('inferenceMs', record.inferenceCompletedAt - record.inferenceStartedAt);
            sample('resultDeliveryMs', record.receivedAt - record.inferenceCompletedAt);
            sample('observedToLandmarkMs', record.receivedAt - record.observedAt);
            if (record.cameraAt !== null) {
                sample('cameraToLandmarkMs', record.receivedAt - record.cameraAt);
            }
            event('landmark', { id: trace.id, hasPose });
        }
        function drawn(trace) {
            count('draws');
            const record = trace && frames.get(trace.id);
            if (!record || !active()) return;
            record.drawCompletedAt = epoch();
            sample('landmarkToDrawMs', record.drawCompletedAt - record.receivedAt);
            sample('observedToDrawMs', record.drawCompletedAt - record.observedAt);
            if (record.cameraAt !== null) {
                sample('cameraToDrawMs', record.drawCompletedAt - record.cameraAt);
            }
        }
        function displayed(rawLandmarks, displayLandmarks) {
            if (!active()) return;
            let offsetSquared = 0;
            let stepSquared = 0;
            let offsetJoints = 0;
            let stepJoints = 0;
            for (let i = 11; rawLandmarks && displayLandmarks && i < rawLandmarks.length; i++) {
                const raw = rawLandmarks[i];
                const display = displayLandmarks[i];
                const previousDisplay = previousDisplayLandmarks?.[i];
                if (!raw || !display || (raw.visibility ?? 1) < 0.5) continue;
                offsetSquared += (display.x - raw.x) ** 2 + (display.y - raw.y) ** 2;
                offsetJoints++;
                if (previousDisplay && (previousDisplay.visibility ?? 1) >= 0.5) {
                    stepSquared += (display.x - previousDisplay.x) ** 2
                        + (display.y - previousDisplay.y) ** 2;
                    stepJoints++;
                }
            }
            if (offsetJoints) {
                sample('displayOffsetRmsNormalized', Math.sqrt(offsetSquared / offsetJoints));
            }
            if (stepJoints) {
                sample('displayStepRmsNormalized', Math.sqrt(stepSquared / stepJoints));
            }
            previousDisplayLandmarks = displayLandmarks?.map(({ x, y, visibility }) => ({
                x, y, visibility
            })) ?? null;
        }
        function sent(trace, bufferedBytes) {
            count('keypointsSent');
            const record = trace && frames.get(trace.id);
            if (!record || !active()) return undefined;
            record.sentAt = epoch();
            record.bufferedBytesAtSend = bufferedBytes;
            sample('landmarkToSendMs', record.sentAt - record.receivedAt);
            return { frameId: trace.id };
        }
        function serverResult(timing) {
            if (!timing || !active()) return;
            count('serverResponses');
            const record = frames.get(timing.frameId);
            if (record) {
                record.server = timing;
                record.serverResponseAt = epoch();
                sample('sendToServerResponseMs', record.serverResponseAt - record.sentAt);
                sample('observedToServerResponseMs', record.serverResponseAt - record.observedAt);
            }
            for (const name of ['angleQueueMs', 'angleComputeMs', 'fsmMs', 'serviceMs']) {
                sample(name, timing[name]);
            }
        }
        function videoFrame(metadata) {
            count('videoCallbacks');
            if (Number.isFinite(metadata?.presentedFrames)) {
                if (lastPresentedFrames !== null && metadata.presentedFrames > lastPresentedFrames) {
                    count('presentedFrames', metadata.presentedFrames - lastPresentedFrames);
                } else {
                    count('presentedFrames');
                }
                lastPresentedFrames = metadata.presentedFrames;
            }
        }
        function report() {
            active();
            const seconds = Math.max(0.001, ((stoppedAt ?? clock.now()) - startedAt) / 1000);
            const latency = {};
            for (const [name, values] of Object.entries(samples)) {
                const sorted = [...values].sort((a, b) => a - b);
                latency[name] = {
                    n: sorted.length,
                    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
                    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
                    max: sorted[sorted.length - 1],
                };
            }
            const measuredCounts = {
                videoCallbacks: 0,
                presentedFrames: 0,
                submitted: 0,
                busySkips: 0,
                workerBusyDrops: 0,
                analysisRateSkips: 0,
                resultCallbacks: 0,
                resultsWithPose: 0,
                draws: 0,
                keypointsSent: 0,
                sendCadenceSkips: 0,
                sendBufferSkips: 0,
                serverResponses: 0,
                ...counts,
            };
            const fps = Object.fromEntries([
                'videoCallbacks', 'presentedFrames', 'submitted',
                'resultCallbacks', 'resultsWithPose', 'draws',
                'keypointsSent', 'serverResponses'
            ].map(name => [name, measuredCounts[name] / seconds]));
            return {
                elapsedSeconds: seconds, stopped: stoppedAt !== null, settings: { ...settings },
                counts: measuredCounts,
                fps,
                pipeline: {
                    cameraFps: fps.presentedFrames,
                    videoCallbackFps: fps.videoCallbacks,
                    analysisSubmissionFps: fps.submitted,
                    poseResultFps: fps.resultCallbacks,
                    keypointFps: fps.keypointsSent,
                    busySkips: measuredCounts.busySkips,
                    workerBusyDrops: measuredCounts.workerBusyDrops,
                    analysisRateSkips: measuredCounts.analysisRateSkips,
                    busySkipPct: measuredCounts.videoCallbacks
                        ? (measuredCounts.busySkips * 100) / measuredCounts.videoCallbacks
                        : null,
                    workerDropPct: measuredCounts.submitted
                        ? (measuredCounts.workerBusyDrops * 100)
                            / (measuredCounts.submitted + measuredCounts.workerBusyDrops)
                        : null,
                    captureMs: latency.captureMs ?? null,
                    inferenceMs: latency.inferenceMs ?? null,
                    resultAgeMs: latency.observedToLandmarkMs ?? null,
                    captureToLandmarkMs: latency.observedToLandmarkMs ?? null,
                    captureToDrawMs: latency.observedToDrawMs ?? null,
                    inferenceP95Ms: latency.inferenceMs?.p95 ?? null,
                },
                latency, frames: Array.from(frames.values(), frame => ({ ...frame })),
                events: events.map(value => ({ ...value })),
                notes: 'FPS uses the whole capture interval. Latencies use the latest 600 samples per metric. '
                    + 'Video callbacks/presentedFrames are browser observations, not sensor FPS. '
                    + 'Draw completion is CPU canvas submission, not physical screen presentation. '
                    + 'Server clocks are not subtracted from client clocks. '
                    + 'landmarkStepRmsNormalized measures motion; interpret it as jitter only for stationary, '
                    + 'equally framed subjects at comparable callback rates. '
                    + 'displayOffsetRmsNormalized measures raw-to-display separation; '
                    + 'displayStepRmsNormalized measures displayed motion without retaining coordinates.',
            };
        }
        return {
            epoch, count, sample, event, begin, received, displayed, drawn, sent, serverResult, videoFrame,
            configure(value) { Object.assign(settings, value); },
            report, stop() { active(); if (stoppedAt === null) stoppedAt = clock.now(); return report(); },
        };
    }
    root.createPoseDiagnostics = createPoseDiagnostics;
})(globalThis);
