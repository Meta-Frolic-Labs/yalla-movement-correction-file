const TASKS_VISION_BUNDLE =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";
const TASKS_WASM_ROOT =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

let poseLandmarker = null;
let FilesetResolver = null;
let PoseLandmarker = null;

function compactLandmarks(landmarks) {
    if (!landmarks?.length) {
        return null;
    }
    return landmarks.map((landmark) => ({
        x: landmark.x,
        y: landmark.y,
        z: landmark.z || 0,
        visibility: landmark.visibility ?? 1,
        presence: landmark.presence ?? 1,
    }));
}

async function createLandmarker(vision, modelUrl, delegate) {
    return PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: modelUrl,
            delegate,
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: 0.68,
        minPosePresenceConfidence: 0.68,
        minTrackingConfidence: 0.68,
        outputSegmentationMasks: false,
    });
}

async function initialize(modelUrl) {
    // Tasks Vision's Emscripten bootstrap requires importScripts(), which is
    // available in this classic worker. The vision bundle itself stays ESM.
    ({ FilesetResolver, PoseLandmarker } = await import(TASKS_VISION_BUNDLE));
    const vision = await FilesetResolver.forVisionTasks(TASKS_WASM_ROOT);
    let delegate = "GPU";
    let gpuFallbackReason = null;
    try {
        poseLandmarker = await createLandmarker(vision, modelUrl, delegate);
    } catch (gpuError) {
        delegate = "CPU";
        gpuFallbackReason = gpuError?.message || String(gpuError);
        poseLandmarker = await createLandmarker(vision, modelUrl, delegate);
    }
    self.postMessage({ type: "ready", delegate, gpuFallbackReason });
}

self.onmessage = async (event) => {
    const message = event.data || {};
    if (message.type === "init") {
        try {
            await initialize(message.modelUrl);
        } catch (error) {
            self.postMessage({
                type: "error",
                stage: "initialization",
                message: error?.message || String(error),
            });
        }
        return;
    }

    if (message.type !== "frame") {
        return;
    }

    const frame = message.frame;
    if (!poseLandmarker) {
        frame?.close?.();
        self.postMessage({
            type: "error",
            stage: "inference",
            message: "Pose Landmarker is not ready.",
        });
        return;
    }

    try {
        const inferenceStartedAt = performance.now();
        const result = poseLandmarker.detectForVideo(frame, message.timestampMs);
        const inferenceMs = performance.now() - inferenceStartedAt;
        self.postMessage({
            type: "result",
            timestampMs: message.timestampMs,
            mediaTime: message.mediaTime,
            captureMs: message.captureMs,
            inferenceMs,
            landmarks: compactLandmarks(result.landmarks?.[0]),
            worldLandmarks: compactLandmarks(result.worldLandmarks?.[0]),
        });
    } catch (error) {
        self.postMessage({
            type: "error",
            stage: "inference",
            message: error?.message || String(error),
        });
    } finally {
        frame?.close?.();
    }
};
