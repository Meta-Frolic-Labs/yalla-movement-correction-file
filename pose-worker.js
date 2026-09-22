const TASKS_VISION_BUNDLE =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
const TASKS_WASM_ROOT =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const PROTOCOL_VERSION = 1;

const DEFAULT_LANDMARKER_OPTIONS = Object.freeze({
    minPoseDetectionConfidence: 0.65,
    minPosePresenceConfidence: 0.65,
    minTrackingConfidence: 0.5,
});

let poseLandmarker = null;

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

function postError(stage, error, frameId) {
    self.postMessage({
        type: "error",
        protocolVersion: PROTOCOL_VERSION,
        stage,
        ...(frameId == null ? {} : { frameId }),
        message: error?.message || String(error),
    });
}

async function createLandmarker(
    PoseLandmarker,
    vision,
    modelUrl,
    delegate,
    landmarkerOptions = {}
) {
    const confidence = {
        ...DEFAULT_LANDMARKER_OPTIONS,
        ...landmarkerOptions,
    };
    return PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
            modelAssetPath: modelUrl,
            delegate,
        },
        runningMode: "VIDEO",
        numPoses: 1,
        minPoseDetectionConfidence: confidence.minPoseDetectionConfidence,
        minPosePresenceConfidence: confidence.minPosePresenceConfidence,
        minTrackingConfidence: confidence.minTrackingConfidence,
        outputSegmentationMasks: false,
    });
}

async function initialize(modelUrl, landmarkerOptions) {
    // Tasks Vision's Emscripten bootstrap requires importScripts(), which is
    // available in this classic worker. The vision bundle itself stays ESM.
    const { FilesetResolver, PoseLandmarker } = await import(TASKS_VISION_BUNDLE);
    const vision = await FilesetResolver.forVisionTasks(TASKS_WASM_ROOT);
    let delegate = "GPU";
    let gpuFallbackReason = null;
    try {
        poseLandmarker = await createLandmarker(
            PoseLandmarker,
            vision,
            modelUrl,
            delegate,
            landmarkerOptions
        );
    } catch (gpuError) {
        delegate = "CPU";
        gpuFallbackReason = gpuError?.message || String(gpuError);
        poseLandmarker = await createLandmarker(
            PoseLandmarker,
            vision,
            modelUrl,
            delegate,
            landmarkerOptions
        );
    }
    self.postMessage({
        type: "ready",
        protocolVersion: PROTOCOL_VERSION,
        delegate,
        gpuFallbackReason,
    });
}

self.onmessage = async (event) => {
    const message = event.data || {};
    if (message.protocolVersion !== PROTOCOL_VERSION) {
        message.frame?.close?.();
        postError(
            message.type === "init" ? "initialization" : "inference",
            new Error(`Unsupported pose-worker protocol: ${message.protocolVersion}`),
            message.frameId
        );
        return;
    }
    if (message.type === "init") {
        try {
            await initialize(
                message.modelUrl,
                message.landmarkerOptions
            );
        } catch (error) {
            postError("initialization", error);
        }
        return;
    }

    if (message.type !== "frame") {
        return;
    }

    const frame = message.frame;
    if (!poseLandmarker) {
        frame?.close?.();
        postError("inference", new Error("Pose Landmarker is not ready."), message.frameId);
        return;
    }

    try {
        const inferenceStartedAt = performance.now();
        const diagnosticTrace = message.diagnosticTrace;
        if (diagnosticTrace) {
            diagnosticTrace.inferenceStartedAt = performance.timeOrigin + inferenceStartedAt;
        }
        const result = poseLandmarker.detectForVideo(frame, message.timestampMs);
        const inferenceMs = performance.now() - inferenceStartedAt;
        if (diagnosticTrace) {
            diagnosticTrace.inferenceCompletedAt = performance.timeOrigin + performance.now();
        }
        self.postMessage({
            type: "result",
            protocolVersion: PROTOCOL_VERSION,
            frameId: message.frameId,
            timestampMs: message.timestampMs,
            mediaTime: message.mediaTime,
            captureMs: message.captureMs,
            inferenceMs,
            ...(message.cropPixels ? { cropPixels: message.cropPixels } : {}),
            ...(diagnosticTrace ? { diagnosticTrace } : {}),
            landmarks: compactLandmarks(result.landmarks?.[0]),
            worldLandmarks: compactLandmarks(result.worldLandmarks?.[0]),
        });
    } catch (error) {
        postError("inference", error, message.frameId);
    } finally {
        frame?.close?.();
    }
};
