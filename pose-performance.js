(function exposePosePerformance(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.createPosePerformanceMonitor = api.createPosePerformanceMonitor;
}(typeof globalThis !== 'undefined' ? globalThis : window, function buildPosePerformance() {
    function createPosePerformanceMonitor({
        sampleSize = 60,
        now = () => performance.now(),
        onWindow = () => {}
    } = {}) {
        let sampleCount = 0;
        let captureTotalMs = 0;
        let inferenceTotalMs = 0;
        let resultAgeTotalMs = 0;
        let skippedFrames = 0;
        let windowStartedAt = now();

        function reset() {
            sampleCount = 0;
            captureTotalMs = 0;
            inferenceTotalMs = 0;
            resultAgeTotalMs = 0;
            skippedFrames = 0;
            windowStartedAt = now();
        }

        function skipped() {
            skippedFrames += 1;
        }

        function record({ captureMs = 0, inferenceMs = 0, resultAgeMs = 0 }) {
            if (sampleCount === 0) windowStartedAt = now();
            sampleCount += 1;
            captureTotalMs += captureMs;
            inferenceTotalMs += inferenceMs;
            resultAgeTotalMs += resultAgeMs;
            if (sampleCount < sampleSize) return null;

            const elapsedMs = Math.max(1, now() - windowStartedAt);
            const metrics = Object.freeze({
                inputFps: Number((sampleCount * 1000 / elapsedMs).toFixed(1)),
                averageCaptureMs: Number((captureTotalMs / sampleCount).toFixed(1)),
                averageInferenceMs: Number((inferenceTotalMs / sampleCount).toFixed(1)),
                averageResultAgeMs: Number((resultAgeTotalMs / sampleCount).toFixed(1)),
                skippedVideoFrames: skippedFrames
            });
            onWindow(metrics);
            reset();
            return metrics;
        }

        return Object.freeze({ record, reset, skipped });
    }

    return { createPosePerformanceMonitor };
}));
