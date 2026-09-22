(function exposePoseFrameLoop(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.createCameraFrameLoop = api.createCameraFrameLoop;
}(typeof globalThis !== 'undefined' ? globalThis : window, function buildPoseFrameLoop(root) {
    function defaultYieldToMainThread() {
        if (typeof root.scheduler?.yield !== 'function') {
            return Promise.resolve();
        }
        return root.scheduler.yield().catch(() => undefined);
    }

    function createCameraFrameLoop({
        video,
        isActive,
        onFrame,
        useVideoFrameCallback = () => true,
        requestAnimationFrame = root.requestAnimationFrame?.bind(root),
        cancelAnimationFrame = root.cancelAnimationFrame?.bind(root),
        yieldToMainThread = defaultYieldToMainThread
    }) {
        let videoFrameHandle = null;
        let animationFrameHandle = null;

        function stop() {
            if (
                videoFrameHandle !== null
                && typeof video.cancelVideoFrameCallback === 'function'
            ) {
                video.cancelVideoFrameCallback(videoFrameHandle);
            }
            if (
                animationFrameHandle !== null
                && typeof cancelAnimationFrame === 'function'
            ) {
                cancelAnimationFrame(animationFrameHandle);
            }
            videoFrameHandle = null;
            animationFrameHandle = null;
        }

        function schedule() {
            if (!isActive()) return false;
            if (
                useVideoFrameCallback()
                && typeof video.requestVideoFrameCallback === 'function'
            ) {
                videoFrameHandle = video.requestVideoFrameCallback(handleVideoFrame);
                return true;
            }
            if (typeof requestAnimationFrame !== 'function') return false;
            animationFrameHandle = requestAnimationFrame(handleAnimationFrame);
            return true;
        }

        async function handleVideoFrame(now, metadata) {
            videoFrameHandle = null;
            // Schedule first so capture/inference work cannot break the callback chain.
            schedule();
            await yieldToMainThread();
            return onFrame(now, metadata);
        }

        function handleAnimationFrame(now) {
            animationFrameHandle = null;
            schedule();
            return onFrame(now, undefined);
        }

        function start() {
            stop();
            return schedule();
        }

        return Object.freeze({ start, stop });
    }

    return { createCameraFrameLoop };
}));
