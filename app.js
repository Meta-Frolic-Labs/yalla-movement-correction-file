// Configuration — frontend and backend run on separate ports
const poseDebugOptions = new URLSearchParams(window.location.search);
const cameraOnlyMode = poseDebugOptions.get('cameraOnly') === '1';
const requestedCameraMode = poseDebugOptions.get('cameraMode');
const CAMERA_DIAGNOSTIC_MODES = Object.freeze([
    'camera', 'callback', 'capture', 'pose', 'canvas', 'full'
]);
const cameraDiagnosticMode = cameraOnlyMode
    ? 'camera'
    : CAMERA_DIAGNOSTIC_MODES.includes(requestedCameraMode)
        ? requestedCameraMode
        : null;
// Isolated stages never start exercise/WebSocket flows.
const isolatedCameraDiagnostic = ['camera', 'callback', 'capture', 'pose', 'canvas']
    .includes(cameraDiagnosticMode);
const cameraMetricsEnabled = cameraDiagnosticMode !== null;
// Prefer 30 FPS when the track can hold it; ?cameraFps=24 opts out.
const requestStableThirtyFps = poseDebugOptions.get('cameraFps') !== '24';
// Default: maximum pose throughput. Single-in-flight + latest-frame
// remain the only backpressure. Set poseIntervalMs>0 to budget capture
// if the live <video> compositor needs headroom on a weak device.
const DEFAULT_POSE_CAPTURE_INTERVAL_MS = 0;
function parsePoseIntervalMs(raw) {
    if (raw === null || raw === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
}
const requestedPoseIntervalMs = parsePoseIntervalMs(
    poseDebugOptions.get('poseIntervalMs')
);
const poseCaptureIntervalMs = requestedPoseIntervalMs !== null
    ? requestedPoseIntervalMs
    : DEFAULT_POSE_CAPTURE_INTERVAL_MS;
// A/B worker scheduling (?poseAbMode=):
//   a = wait for inference, then capture the next fresh camera frame (default)
//   b = keep one pre-captured frame pending while the worker runs (throughput test)
// A avoids displaying a bitmap that has already waited behind another inference.
const POSE_AB_MODE = poseDebugOptions.get('poseAbMode') === 'b' ? 'b' : 'a';
const poseDiagnostics = window.createPoseDiagnostics?.(
    cameraMetricsEnabled ? '?poseDebug=1' : window.location.search
);
const poseLandmarkSmoother = window.createPoseLandmarkSmoother();
window.poseDiagnostics = poseDiagnostics;
window.__poseScheduler = {
    intervalMs: poseCaptureIntervalMs,
    defaultIntervalMs: DEFAULT_POSE_CAPTURE_INTERVAL_MS,
    requestedIntervalMs: requestedPoseIntervalMs
};
let legacyDiagnosticTrace = null;
// Lite keeps the Android overlay responsive. Desktop keeps Full, while every
// platform can still be overridden with ?poseModel=lite|full|heavy.
const requestedPoseModel = poseDebugOptions.get('poseModel');
const POSE_MODEL_VARIANT = requestedPoseModel === 'lite'
    ? 'lite'
    : requestedPoseModel === 'heavy'
        ? 'heavy'
        : requestedPoseModel === 'full'
            ? 'full'
            : (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
                ? 'lite'
                : 'full');
const isLocalFrontendHost = ['localhost', '127.0.0.1', '[::1]']
    .includes(window.location.hostname);
const BACKEND_URL =
    poseDebugOptions.get('backend')
    || (isLocalFrontendHost
        ? 'http://127.0.0.1:8001'
        : 'https://yalla-ai.onlinetestingserver.com');
const API_BASE_URL = `${BACKEND_URL}/v1/exercise`;
const POSE_MODEL_REVISION = POSE_MODEL_VARIANT === 'lite' ? '1' : 'latest';
const POSE_CONFIDENCE_PROFILES = Object.freeze({
    a: { detect: 0.5, presence: 0.5, track: 0.5 },
    b: { detect: 0.6, presence: 0.6, track: 0.5 },
    c: { detect: 0.65, presence: 0.65, track: 0.5 },
    d: { detect: 0.7, presence: 0.65, track: 0.55 },
    e: { detect: 0.65, presence: 0.7, track: 0.6 }
});
function parseUnitIntervalParam(name, fallback) {
    const raw = poseDebugOptions.get(name);
    if (raw === null || raw === '') {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        return fallback;
    }
    return value;
}
const requestedPoseConfProfile = poseDebugOptions.get('poseConfProfile')?.toLowerCase();
const activePoseConfProfile = POSE_CONFIDENCE_PROFILES[requestedPoseConfProfile] || null;
const POSE_TASK_DETECTION_CONFIDENCE = parseUnitIntervalParam(
    'poseDetect',
    activePoseConfProfile?.detect ?? 0.65
);
const POSE_TASK_PRESENCE_CONFIDENCE = parseUnitIntervalParam(
    'posePresence',
    activePoseConfProfile?.presence ?? 0.65
);
const POSE_TASK_TRACKING_CONFIDENCE = parseUnitIntervalParam(
    'poseTrack',
    activePoseConfProfile?.track ?? 0.5
);
const TRACKING_POSE_CONFIDENCE = parseUnitIntervalParam('poseTrackingConf', 0.48);
const FORM_POSE_CONFIDENCE = parseUnitIntervalParam('poseFormConf', 0.65);
const POSE_MODEL_URL =
    `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${POSE_MODEL_VARIANT}/float16/${POSE_MODEL_REVISION}/pose_landmarker_${POSE_MODEL_VARIANT}.task`;
const LEGACY_POSE_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/pose.js';
const LEGACY_POSE_BASE =
    'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404';
const runtimeScriptLoads = new Map();

function loadRuntimeScript(url, ready) {
    if (ready()) return Promise.resolve();
    if (runtimeScriptLoads.has(url)) return runtimeScriptLoads.get(url);
    const load = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => ready()
            ? resolve()
            : reject(new Error(`Runtime did not initialize after loading ${url}`));
        script.onerror = () => reject(new Error(`Unable to load ${url}`));
        document.head.appendChild(script);
    });
    runtimeScriptLoads.set(url, load);
    return load;
}

async function loadLegacyPoseRuntime() {
    await loadRuntimeScript(
        LEGACY_POSE_URL,
        () => typeof window.Pose === 'function'
    );
}
// Body + limbs only. Face mesh and hand fans make wrists look thick and
// pull drawn hand tips into the wrist/elbow during curls.
const POSE_CONNECTIONS = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [27, 29], [27, 31],
    [24, 26], [26, 28], [28, 30], [28, 32]
];
const SKELETON_LANDMARK_INDEXES = Object.freeze([
    11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32
]);
const {
    exercises,
    resolveExercise,
    isMultiModeExercise
} = window.exerciseRegistry;

function exerciseIconUrl(exercise) {
    return exercise?.iconPath
        ? new URL(exercise.iconPath, document.baseURI).href
        : '';
}

function updateSessionUrl(id, exerciseKey) {
    const apiExercise = resolveExercise(exerciseKey)?.apiName || exerciseKey;
    const params = new URLSearchParams({
        session_id: String(id),
        exercise: apiExercise
    });
    if (isMultiModeExercise(apiExercise)) {
        params.set('mode', multiModeMode);
        params.set('selected_side', multiModeSelectedSide);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    history.replaceState({ sessionId: id, exercise: apiExercise }, '', newUrl);
}

function clearSessionUrl() {
    history.replaceState({}, '', window.location.pathname);
}

function notifyNativeApp(payload) {
    if (window.ReactNativeWebView?.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
}

function beginExerciseSession(selectedExerciseKey) {
    exerciseName = resolveExercise(selectedExerciseKey)?.key
        || selectedExerciseKey;
    isPlankExercise = exerciseName.includes('plank');

    if (isPlankExercise) {
        counterLabel.textContent = 'TIME';
        counterLabelMobile.textContent = 'Time:';
    }

    exerciseActive = true;
    document.body.classList.remove('picker-active');
    document.body.classList.add('exercise-active');
    document.getElementById('exercise-picker').style.display = 'none';
    document.getElementById('hammer-details').hidden =
        exerciseName !== 'hammer_curl_rules';
    document.getElementById('front-raise-details').hidden =
        !['shoulder_front_raise_rules', 'shoulder_lateral_raise_rules'].includes(exerciseName);
    document.getElementById('rdl-details').hidden =
        exerciseName !== 'romanian_deadlift_rules';

    const lateralRaise = exerciseName === 'shoulder_lateral_raise_rules';
    const shoulderRaiseTitle = document.getElementById('shoulder-raise-details-title');
    const shoulderRaiseInstructions = document.getElementById('shoulder-raise-instructions');
    if (shoulderRaiseTitle) {
        shoulderRaiseTitle.textContent = lateralRaise
            ? 'SHOULDER LATERAL RAISE DETAILS'
            : 'SHOULDER FRONT RAISE DETAILS';
    }
    if (shoulderRaiseInstructions) {
        shoulderRaiseInstructions.innerHTML = lateralRaise
            ? `
                <li>Stand facing the camera with arms at your sides.</li>
                <li>Keep your arms straight as you raise out to the sides.</li>
                <li>Raise your elbows to the dotted line, then lower with control.</li>
                <li>Keep shoulders, elbows, wrists, and hips visible.</li>
            `
            : `
                <li>Stand facing the camera with arms at your sides.</li>
                <li>Keep your arms straight as you raise forward.</li>
                <li>Raise your elbows to the dotted line, then lower with control.</li>
                <li>Keep shoulders, elbows, wrists, and hips visible.</li>
            `;
    }

    const positionInstructions = document.getElementById('position-instructions');
    if (exerciseName === 'romanian_deadlift_rules') {
        positionInstructions.textContent =
            'Use a clear side view and keep one full shoulder-to-ankle side visible.';
    } else if (exerciseName === 'leg_raise_rules') {
        positionInstructions.textContent =
            'Lie on your back, turn sideways to the camera, and keep both legs visible.';
    } else if (isMultiModeExercise(exerciseName)) {
        positionInstructions.textContent =
            'Use a front-facing view and keep both shoulders, elbows, wrists, and hips visible.';
    } else {
        positionInstructions.textContent =
            'Please make sure your entire body is visible in the frame';
    }
    showExerciseView();
    initializeExercise();
}

async function startExerciseFromBrowser(exerciseKey) {
    const exercise = resolveExercise(exerciseKey);
    if (!exercise) {
        showError('Invalid exercise selected.');
        return;
    }
    const apiExercise = exercise.apiName;

    try {
        const response = await fetch(`${API_BASE_URL}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                exercise: apiExercise,
                mode: exercise.multiMode ? multiModeMode : 'single',
                selected_side: exercise.multiMode
                    ? multiModeSelectedSide
                    : 'left'
            })
        });
        const data = await response.json();

        if (!response.ok) {
            const detail = Array.isArray(data.detail)
                ? data.detail.map((item) => item.msg || item).join(', ')
                : (data.detail || 'Failed to start exercise');
            showError(detail);
            return;
        }

        sessionId = data.session_id;
        updateSessionUrl(sessionId, exerciseKey);
        beginExerciseSession(exerciseKey);
    } catch (error) {
        console.error('Failed to start exercise:', error);
        showError('Could not connect to the backend. Make sure the API is running.');
    }
}

function showExercisePicker() {
    const picker = document.getElementById('exercise-picker');
    const grid = document.getElementById('exercise-grid');
    grid.innerHTML = '';

    exercises.forEach((exercise) => {
        const { key, label } = exercise;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'exercise-card';
        card.innerHTML = `
            <img src="${exerciseIconUrl(exercise)}" alt="${label}">
            <h3>${label}</h3>
        `;
        card.addEventListener('click', (event) => {
            event.currentTarget.blur();
            const config = document.getElementById('multi-mode-config');
            if (exercise.multiMode) {
                pendingMultiModeExerciseKey = key;
                document.getElementById('multi-mode-config-title').textContent =
                    `${label} Setup`;
                document.getElementById('start-multi-mode-exercise').textContent =
                    `Start ${label}`;
                config.hidden = false;
            } else {
                config.hidden = true;
                startExerciseFromBrowser(key);
            }
        });
        grid.appendChild(card);
    });

    picker.style.display = 'block';
    document.body.classList.add('picker-active');
    document.body.classList.remove('exercise-active');
    document.getElementById('multi-mode-config').hidden = true;
    exerciseView.classList.remove('active');
    exerciseView.style.display = 'none';
}

// Global variables
let ws = null;
let pose = null;
let poseWorker = null;
let poseWorkerReady = false;
let poseWorkerInitializationTimer = null;
let poseFrameInFlight = false;
let poseWorkerInferenceBusy = false;
let pendingPoseWorkerSubmission = null;
let posePipelineGeneration = 0;
let posePipelineMode = 'none';
let poseFallbackStarted = false;
let poseBitmapFailureCount = 0;
let poseWorkerFailureCount = 0;
let poseFrameLoopController = null;
let captureOnlyFrameLoopController = null;
let lastSubmittedVideoTime = -1;
let lastPoseCaptureAt = 0;
let captureOnlyInFlight = false;
let poseCaptureCanvas = null;
let poseCaptureCtx = null;
let poseDelegate = 'unknown';
let poseGpuFallbackReason = null;
const POSE_PERFORMANCE_LOG_INTERVAL = 60;
const POSE_ANALYSIS_MAX_DIMENSION = 416;
const POSE_DRAW_MAX_DIMENSION = 640;
const MAX_POSE_PIPELINE_FAILURES = 2;
const POSE_WORKER_PROTOCOL_VERSION = 1;
let nextPoseWorkerFrameId = 1;
const CAMERA_VIDEO_CONSTRAINTS = Object.freeze({
    facingMode: 'user',
    width: { ideal: 480, max: 640 },
    height: { ideal: 360, max: 480 },
    frameRate: { ideal: 30, max: 30 }
});
const voiceFeedbackEnabled = poseDebugOptions.get('voice') !== '0';
let camera = null;
let cameraMetricsState = null;
let cameraMetricsFrameCallback = null;
let cameraMetricsInterval = null;
let cameraLongTaskObserver = null;
let sessionId = null;
let exerciseName = null;
let personDetected = true;
let missingFrames = 0;
const MISSING_THRESHOLD = 8;
let exerciseActive = false;
let multiModeMode = 'single';
let multiModeSelectedSide = 'left';
let pendingMultiModeExerciseKey = null;
// 0 = send every accepted pose result (websocket buffer still gates).
const KEYPOINT_SEND_INTERVAL_MS = 0;
const MAX_WEBSOCKET_BUFFER_BYTES = 64 * 1024;
let nextKeypointSendAt = null;
const posePerformanceMonitor = createPosePerformanceMonitor({
    sampleSize: POSE_PERFORMANCE_LOG_INTERVAL,
    onWindow: reportPosePerformance
});

function advanceKeypointDeadline(now, deadline) {
    if (!(KEYPOINT_SEND_INTERVAL_MS > 0)) return now;
    if (deadline === null) return now + KEYPOINT_SEND_INTERVAL_MS;
    // Keep the cadence when inference falls between send deadlines.
    // Skip missed slots; never enqueue or send catch-up frames.
    const slots = Math.floor(Math.max(0, now - deadline) / KEYPOINT_SEND_INTERVAL_MS) + 1;
    return deadline + slots * KEYPOINT_SEND_INTERVAL_MS;
}
let lastTrackingMethod = null;
let shoulderRaiseGuideY = null;

// Whole body detection variables
const bodyVisibilityThreshold = 0.55;
const keyPointVisibilityThreshold = 0.4;
const deadliftLandmarkVisibilityThreshold = 0.5;
// Keep the single-arm framing gate aligned with the exercise rules.
// A stricter UI-only threshold caused valid iOS legacy-pose frames to
// remain behind the positioning overlay while the backend accepted them.
const trackingLandmarkVisibilityThreshold = 0.45;
const DISPLAY_POSE_CONFIDENCE = TRACKING_POSE_CONFIDENCE;
const POSE_LOCK_LANDMARK_CONFIDENCE = TRACKING_POSE_CONFIDENCE;
const POSE_REACQUIRE_FRAMES = 3;
const VALID_POSE_COLOR = '#00FF00';
const INVALID_POSE_COLOR = '#FF2D2D';
const SKELETON_CONNECTOR_STYLE = Object.freeze({ lineWidth: 1.5 });
const SKELETON_LANDMARK_STYLE = Object.freeze({
    radius: 2
});
// null means no pose frame has confirmed visibility yet. Starting at
// false skipped the first "not visible" transition and hid the prompt.
let wholeBodyDetected = null;
let latestFormOk = false;
let formValidationReceived = false;
let occlusionSent = false;
let deadliftTrackingStarted = false;

let firstPoseResultReceived = false;

// Timer variables for plank exercises
let timerInterval = null;
let elapsedTime = 0;
let timerRunning = false;
let isPlankExercise = false;
let lastTimerUpdate = 0;
let overlayActive = false;
const validPlankFeedbacks = [
    "Doing Good, Maintain body",
    "Hips too high - lower them to be perfectly straight!",
    "Hips sagging - lift them up slightly!",
    "Perfect plank!",
    "Doing Good Keep it"
];

class FeedbackVoice {
    constructor() {
        this.synth = window.speechSynthesis;
        this.currentUtterance = null;
        this.lastFeedback = '';
        this.isSpeaking = false;
        this.feedbackCooldown = 2000;
    }

    speak(feedbackText) {
        if (!voiceFeedbackEnabled) return;
        if (!feedbackText) return;

        if (feedbackText === "No feedback yet" || feedbackText === "No person detected") {
            return;
        }

        const now = Date.now();
        const isSameFeedback = feedbackText === this.lastFeedback;
        const isInCooldown = (now - this.lastSpeakTime) < this.feedbackCooldown;

        // Skip if same feedback in cooldown
        if (isSameFeedback && isInCooldown) {
            console.log(` Feedback skipping repetitive: "${feedbackText}"`);
            return;
        }

        console.log(` FEEDBACK VOICE: "${feedbackText}"`);

        // Stop any current feedback speech
        if (this.isSpeaking) {
            this.synth.cancel();
        }

        this.currentUtterance = new SpeechSynthesisUtterance(feedbackText);

        // Optimize for feedback - clear and calm
        this.currentUtterance.rate = 0.9;
        this.currentUtterance.pitch = 1.0;
        this.currentUtterance.volume = 0.8;

        this.currentUtterance.onstart = () => {
            this.isSpeaking = true;
            this.lastSpeakTime = Date.now();
            console.log(' Feedback voice started');
        };

        this.currentUtterance.onend = () => {
            this.isSpeaking = false;
            this.lastFeedback = feedbackText;
            console.log(' Feedback voice ended');
        };

        this.currentUtterance.onerror = (event) => {
            this.isSpeaking = false;
            if (event.error !== 'interrupted') {
                console.error(' Feedback voice error:', event.error);
            }
        };

        this.synth.speak(this.currentUtterance);
    }

    stop() {
        if (this.isSpeaking) {
            this.synth.cancel();
            this.isSpeaking = false;
        }
    }

    reset() {
        this.lastFeedback = '';
        this.stop();
    }
}

const feedbackVoice = new FeedbackVoice();

// Tracking variables
let lastFeedbackText = "";
let lastFormStatus = "";
let lastDisplayedReps = "";

// DOM Elements
const exerciseView = document.getElementById('exercise-view');
const stopBtn = document.getElementById('stop-btn');
const repCounter = document.getElementById('rep-counter');
const formStatus = document.getElementById('form-status');
const feedbackText = document.getElementById('feedback-text');
const cameraStream = document.getElementById('camera-stream');
const poseCanvas = document.getElementById('pose-canvas');
const loader = document.querySelector('.loader');
const cameraPermission = document.querySelector('.camera-permission');
const personDetectionOverlay = document.querySelector('.person-detection-overlay');
const counterLabel = document.getElementById('counter-label');
const counterLabelMobile = document.getElementById('counter-label-mobile');
const mobileRepCounter = document.getElementById('rep-counter-mobile');
const mobileFormStatus = document.getElementById('form-status-mobile');
const mobileFeedbackText = document.getElementById('feedback-text-mobile');
const mobileExerciseName = document.getElementById('exercise-name-mobile');
const exerciseIcon = document.getElementById('exercise-icon');
const overlayExerciseName = document.getElementById('overlay-exercise-name');
const noPersonText = document.getElementById('no-person-text');
const cameraDiagnosticsPanel = document.getElementById('camera-diagnostics');
const cameraDiagnosticsOutput = document.getElementById('camera-diagnostics-output');

console.log(' Exercise page loaded - initializing...', exerciseIcon);

function setRepDisplay(value, { alternating = false, time = false, pulse = false } = {}) {
    const text = String(value);
    repCounter.textContent = text;
    counterLabel.textContent = time
        ? 'TIME'
        : alternating ? 'LEFT | RIGHT' : 'REPS';
    if (mobileRepCounter) {
        const changed = mobileRepCounter.textContent !== text;
        mobileRepCounter.textContent = text;
        if (pulse && changed) {
            mobileRepCounter.classList.add('pulse');
            setTimeout(() => mobileRepCounter.classList.remove('pulse'), 1000);
        }
    }
    if (counterLabelMobile) {
        counterLabelMobile.textContent = time
            ? 'Time:'
            : alternating ? 'Left | Right:' : 'Reps:';
    }
}

function setFormDisplay(text, good = false) {
    formStatus.textContent = text;
    formStatus.className = `status ${good ? 'good' : 'bad'}`;
    if (mobileFormStatus) {
        mobileFormStatus.textContent = text;
        mobileFormStatus.className = good ? 'good' : 'bad';
    }
}

function setFeedbackDisplay(text, { animate = false } = {}) {
    const targets = [feedbackText, mobileFeedbackText].filter(Boolean);
    targets.forEach((target) => {
        target.textContent = text;
        if (animate) target.classList.add('is-updating');
    });
    if (animate) {
        setTimeout(() => {
            targets.forEach((target) => target.classList.remove('is-updating'));
        }, 100);
    }
}

function setDetailValues(values) {
    for (const [id, value] of Object.entries(values)) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }
}

// Canonical confidence for gating: min(visibility, presence) when both exist.
function getPoseConfidence(landmark) {
    if (!landmark) return 0;

    const visibility = Number(landmark.visibility);
    const presence = Number(landmark.presence);

    const hasVisibility = Number.isFinite(visibility);
    const hasPresence = Number.isFinite(presence);

    if (hasVisibility && hasPresence) {
        return Math.min(visibility, presence);
    }

    if (hasVisibility) return visibility;
    if (hasPresence) return presence;

    return posePipelineMode === 'legacy' ? 1 : 0;
}

function getLandmarkVisibility(landmark) {
    return getPoseConfidence(landmark);
}

function isLandmarkVisible(landmarks, index, threshold) {
    return (
        index < landmarks.length
        && getPoseConfidence(landmarks[index]) >= threshold
    );
}

const barbellPoseContinuity = createPoseContinuityTracker({
    landmarkConfidence: POSE_LOCK_LANDMARK_CONFIDENCE,
    reacquireFrames: POSE_REACQUIRE_FRAMES,
    getConfidence: getPoseConfidence,
    isRepHardLocked: () => Boolean(getPosePersonRoiState?.()?.repHardLock),
    onReset: () => globalThis.resetPosePersonRoi?.()
});

function resetPosePersonLock() {
    barbellPoseContinuity.reset();
}

function shouldSendPoseToBackend(landmarks) {
    if (!exerciseUsesPoseContinuityGate()) {
        return true;
    }
    return barbellPoseContinuity.accepts(landmarks);
}

function hasDrawablePose(landmarks) {
    // Rendering stays independent from backend identity acquisition so the
    // local overlay never appears frozen while the lock is reacquiring.
    return Boolean(landmarks?.length);
}

function exerciseUsesPoseContinuityGate() {
    return exerciseName === 'barbell_biceps_curl_rules';
}

// Check if whole body is visible
function isWholeBodyVisible(landmarks) {
    if (!landmarks || landmarks.length === 0) return false;

    if (exerciseName === 'barbell_biceps_curl_rules') {
        const curlIndices = [11, 12, 13, 14, 15, 16, 23, 24];
        return curlIndices.every((index) =>
            isLandmarkVisible(landmarks, index, FORM_POSE_CONFIDENCE)
        );
    }

    const multiModeActive = isMultiModeExercise(exerciseName);
    if (exerciseName === 'hammer_curl_rules' && multiModeMode === 'single') {
        const sideIndices = multiModeSelectedSide === 'right'
            ? [12, 14, 16, 24]
            : [11, 13, 15, 23];
        return sideIndices.every((index) =>
            isLandmarkVisible(
                landmarks,
                index,
                trackingLandmarkVisibilityThreshold
            )
        );
    }
    if (
        ['shoulder_front_raise_rules', 'shoulder_lateral_raise_rules'].includes(exerciseName)
        && multiModeMode === 'single'
    ) {
        const sideIndices = multiModeSelectedSide === 'right'
            ? [12, 14, 16, 24]
            : [11, 13, 15, 23];
        return sideIndices.every((index) =>
            isLandmarkVisible(
                landmarks,
                index,
                trackingLandmarkVisibilityThreshold
            )
        );
    }
    if (exerciseName === 'romanian_deadlift_rules') {
        const leftSide = [11, 23, 25, 27];
        const rightSide = [12, 24, 26, 28];
        const sideVisible = (indices) => indices.every((index) =>
            isLandmarkVisible(landmarks, index, 0.60)
        );
        return sideVisible(leftSide) || sideVisible(rightSide);
    }
    if (exerciseName === 'leg_raise_rules') {
        const chainVisible = (indices) => indices.every((index) =>
            isLandmarkVisible(landmarks, index, 0.55)
        );
        const leftChain = [11, 23, 25];
        const rightChain = [12, 24, 26];
        return chainVisible(leftChain) && chainVisible(rightChain);
    }
    if (exerciseName === 'squat_rules') {
        // Ankles flicker at depth; hips + knees + upper body are enough.
        const squatIndices = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];
        return squatIndices.every((index) =>
            isLandmarkVisible(
                landmarks,
                index,
                keyPointVisibilityThreshold
            )
        );
    }
    if (exerciseName === 'deadlift_rules' || exerciseName === 'deadlift') {
        // Initial arming requires the complete chain consumed by the
        // detector. Once armed, ankle flicker must not mask an active cycle.
        const deadliftIndices = deadliftTrackingStarted
            ? [11, 12, 15, 16, 23, 24, 25, 26]
            : [11, 12, 15, 16, 23, 24, 25, 26, 27, 28];
        return deadliftIndices.every((index) =>
            isLandmarkVisible(
                landmarks,
                index,
                deadliftLandmarkVisibilityThreshold
            )
        );
    }
    const keyPointIndices = multiModeActive
        ? [11, 12, 13, 14, 15, 16, 23, 24]
        : [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
    let visiblePoints = 0;

    for (const index of keyPointIndices) {
        if (isLandmarkVisible(
            landmarks,
            index,
            keyPointVisibilityThreshold
        )) {
            visiblePoints++;
        }
    }

    const visibilityPercentage = visiblePoints / keyPointIndices.length;
    return visibilityPercentage >= (
        multiModeActive ? 0.85 : bodyVisibilityThreshold
    );
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
    console.log(' Initializing exercise with SEPARATE voice systems...');

    if (isolatedCameraDiagnostic) {
        initializeIsolatedCameraDiagnostic();
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const urlSessionId = urlParams.get('session_id');
    const urlExerciseName = urlParams.get('exercise');
    multiModeMode = urlParams.get('mode') || 'single';
    multiModeSelectedSide = urlParams.get('selected_side') || 'left';

    if (urlSessionId && urlExerciseName) {
        sessionId = urlSessionId;
        exerciseName = urlExerciseName.toLowerCase();
        document.body.classList.remove('picker-active');
        document.body.classList.add('exercise-active');
        document.getElementById('exercise-picker').style.display = 'none';
        beginExerciseSession(exerciseName);
    } else if (urlSessionId) {
        showError("Exercise name is missing from the URL.");
    } else {
        document.body.classList.add('picker-active');
        showExercisePicker();
    }

    stopBtn.addEventListener('click', stopExercise);

    const multiModeSideField = document.getElementById('multi-mode-side-field');
    const multiModeButtons = document.querySelectorAll('#multi-mode-group .hammer-choice');
    const multiModeSideButtons = document.querySelectorAll('#multi-mode-side-group .hammer-choice');

    const setMultiModeChoiceGroup = (buttons, value) => {
        buttons.forEach((button) => {
            const selected = button.dataset.value === value;
            button.setAttribute('aria-pressed', String(selected));
        });
    };

    const updateMultiModeControls = () => {
        const sideEnabled = multiModeMode === 'single';
        multiModeSideField.classList.toggle('is-disabled', !sideEnabled);
        multiModeSideField.setAttribute('aria-disabled', String(!sideEnabled));
        multiModeSideButtons.forEach((button) => {
            button.disabled = !sideEnabled;
        });
    };

    setMultiModeChoiceGroup(multiModeButtons, multiModeMode);
    setMultiModeChoiceGroup(multiModeSideButtons, multiModeSelectedSide);
    updateMultiModeControls();

    multiModeButtons.forEach((button) => {
        button.addEventListener('click', () => {
            multiModeMode = button.dataset.value;
            setMultiModeChoiceGroup(multiModeButtons, multiModeMode);
            updateMultiModeControls();
        });
    });

    multiModeSideButtons.forEach((button) => {
        button.addEventListener('click', () => {
            if (button.disabled) return;
            multiModeSelectedSide = button.dataset.value;
            setMultiModeChoiceGroup(multiModeSideButtons, multiModeSelectedSide);
        });
    });

    document.getElementById('start-multi-mode-exercise').addEventListener('click', () => {
        if (pendingMultiModeExerciseKey) {
            startExerciseFromBrowser(pendingMultiModeExerciseKey);
        }
    });
});

function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    const title = document.createElement('h3');
    title.textContent = 'Error';
    const description = document.createElement('p');
    description.textContent = message;
    errorDiv.append(title, description);

    document.body.appendChild(errorDiv);

    const closeButton = document.createElement('button');
    closeButton.className = 'error-message-close';
    closeButton.textContent = 'Close';
    closeButton.onclick = function () {
        notifyNativeApp({ event: "stop_exercise" });
        document.body.removeChild(errorDiv);
    };

    errorDiv.appendChild(closeButton);
}

// Reset exercise state
function resetExerciseState() {
    const showAlternatingArmCounts =
        isMultiModeExercise(exerciseName)
        && multiModeMode === 'alternating';
    setRepDisplay(showAlternatingArmCounts ? '0 | 0' : '0', {
        alternating: showAlternatingArmCounts,
        time: isPlankExercise
    });
    setFormDisplay('CHECK');
    setFeedbackDisplay('No feedback yet');
    const activeExercise = resolveExercise(exerciseName);
    if (mobileExerciseName) {
        mobileExerciseName.textContent = activeExercise?.label || "Exercise";
    }

    feedbackVoice.reset();

    personDetected = true;
    missingFrames = 0;
    wholeBodyDetected = null;
    latestFormOk = false;
    formValidationReceived = false;
    nextKeypointSendAt = null;
    shoulderRaiseGuideY = null;
    overlayActive = false;
    occlusionSent = false;
    deadliftTrackingStarted = false;
    poseLandmarkSmoother.reset();
    resetPosePersonLock();

    lastFeedbackText = "";
    lastFormStatus = "";
    lastDisplayedReps = "";
    feedbackFrameCount = 0;

    updateWholeBodyDetectionUI(false);

    elapsedTime = 0;
    timerRunning = false;
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    updateTimerDisplay();

    // Set the exercise icon and name in the overlay
    if (activeExercise?.iconPath) {
        exerciseIcon.src = exerciseIconUrl(activeExercise);
        exerciseIcon.alt = `${activeExercise.label} Icon`;
    }
    if (overlayExerciseName) {
        overlayExerciseName.textContent = activeExercise?.label || exerciseName;
    }

    setDetailValues({
        'hammer-left-angle': '—',
        'hammer-right-angle': '—',
        'hammer-left-reps': '0',
        'hammer-right-reps': '0',
        'hammer-pairs': '0',
        'hammer-total': '0',
        'hammer-state': 'not_ready',
        'hammer-invalid': 'None',
        'front-raise-left-elevation': '—',
        'front-raise-right-elevation': '—',
        'front-raise-left-elbow': '—',
        'front-raise-right-elbow': '—',
        'front-raise-left-reps': '0',
        'front-raise-right-reps': '0',
        'front-raise-pairs': '0',
        'front-raise-state': 'not_ready',
        'front-raise-invalid': 'No failed rep',
        'rdl-tracking-side': '—',
        'rdl-side-visibility': '—',
        'rdl-camera-view': 'unknown',
        'rdl-hip-angle': '—',
        'rdl-knee-angle': '—',
        'rdl-torso-angle': '—',
        'rdl-side-ratio': '—',
        'rdl-side-alignment': '—',
        'rdl-state': 'not_ready',
        'rdl-invalid': 'None'
    });
}

// Show exercise view with animation
function showExerciseView() {
    exerciseView.style.display = 'flex';
    exerciseView.classList.add('active');
    loader.style.display = 'flex';
    cameraPermission.style.display = 'none';
    firstPoseResultReceived = false;
    wholeBodyDetected = null;
    updateWholeBodyDetectionUI(false);
}

// Initialize exercise monitoring
function initializeExercise() {
    if (!pose) {
        initializeMediaPipe();
    }
    initializeWebSocket();

    if (window.innerWidth <= 768) {
        const mobileInfoPanel = document.querySelector('.mobile-info-panel');
        if (mobileInfoPanel) {
            mobileInfoPanel.style.display = 'block';
        }
    }
}

let cameraDimensionSyncBound = false;

function applyCameraAspectRatio() {
    if (!cameraStream.videoWidth || !cameraStream.videoHeight) {
        return false;
    }

    // Draw overlay at a capped buffer size. Matching a 720p/1080p canvas every
    // pose result stalls the main thread and makes the live video feel frozen.
    const sourceWidth = cameraStream.videoWidth;
    const sourceHeight = cameraStream.videoHeight;
    const drawScale = Math.min(
        1,
        POSE_DRAW_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight)
    );
    poseCanvas.width = Math.max(1, Math.round(sourceWidth * drawScale));
    poseCanvas.height = Math.max(1, Math.round(sourceHeight * drawScale));
    shoulderRaiseGuideY = null;

    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
        // Fill the placeholder box; object-fit:contain shows the full FOV (letterboxed).
        poseCanvas.style.width = '100%';
        poseCanvas.style.height = '100%';
        cameraStream.style.width = '100%';
        cameraStream.style.height = '100%';
        poseCanvas.style.aspectRatio = '';
        cameraStream.style.aspectRatio = '';
    } else {
        const aspectRatio = `${sourceWidth} / ${sourceHeight}`;
        poseCanvas.style.width = '100%';
        poseCanvas.style.height = '100%';
        poseCanvas.style.aspectRatio = aspectRatio;
        cameraStream.style.width = '100%';
        cameraStream.style.height = 'auto';
        cameraStream.style.aspectRatio = aspectRatio;
    }
    return true;
}

function ensurePoseCanvasMatchesVideo() {
    if (!cameraStream.videoWidth || !cameraStream.videoHeight) {
        return false;
    }
    const sourceWidth = cameraStream.videoWidth;
    const sourceHeight = cameraStream.videoHeight;
    const drawScale = Math.min(
        1,
        POSE_DRAW_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight)
    );
    const expectedWidth = Math.max(1, Math.round(sourceWidth * drawScale));
    const expectedHeight = Math.max(1, Math.round(sourceHeight * drawScale));
    if (
        poseCanvas.width === expectedWidth
        && poseCanvas.height === expectedHeight
    ) {
        return true;
    }
    return applyCameraAspectRatio();
}

function onCameraDimensionsReady() {
    if (applyCameraAspectRatio()) {
        console.info('Camera dimensions synced', {
            width: cameraStream.videoWidth,
            height: cameraStream.videoHeight
        });
    }
}

function bindCameraDimensionSync() {
    if (cameraDimensionSyncBound) {
        return;
    }
    cameraDimensionSyncBound = true;
    cameraStream.addEventListener('loadedmetadata', onCameraDimensionsReady);
    cameraStream.addEventListener('resize', onCameraDimensionsReady);
    window.addEventListener('orientationchange', onCameraDimensionsReady);
    window.addEventListener('resize', onCameraDimensionsReady);
}

function unbindCameraDimensionSync() {
    if (!cameraDimensionSyncBound) {
        return;
    }
    cameraDimensionSyncBound = false;
    cameraStream.removeEventListener('loadedmetadata', onCameraDimensionsReady);
    cameraStream.removeEventListener('resize', onCameraDimensionsReady);
    window.removeEventListener('orientationchange', onCameraDimensionsReady);
    window.removeEventListener('resize', onCameraDimensionsReady);
}

function waitForCameraDimensions(timeoutMs = 5000) {
    if (cameraStream.videoWidth && cameraStream.videoHeight) {
        applyCameraAspectRatio();
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        let settled = false;
        const finish = (ready) => {
            if (settled) {
                return;
            }
            settled = true;
            cameraStream.removeEventListener('loadedmetadata', onReady);
            cameraStream.removeEventListener('resize', onReady);
            clearTimeout(timer);
            resolve(ready);
        };
        const onReady = () => {
            if (cameraStream.videoWidth && cameraStream.videoHeight) {
                applyCameraAspectRatio();
                finish(true);
            }
        };
        cameraStream.addEventListener('loadedmetadata', onReady);
        cameraStream.addEventListener('resize', onReady);
        const timer = setTimeout(() => {
            finish(Boolean(
                cameraStream.videoWidth && cameraStream.videoHeight
            ));
        }, timeoutMs);
    });
}

function cancelPoseFrameLoop() {
    poseFrameLoopController?.stop();
    captureOnlyFrameLoopController?.stop();
    captureOnlyInFlight = false;
}

function stopPosePipeline() {
    posePipelineGeneration += 1;
    cancelPoseFrameLoop();
    poseFrameInFlight = false;
    poseWorkerInferenceBusy = false;
    clearPendingPoseWorkerSubmission();
    poseWorkerReady = false;
    posePipelineMode = 'none';
    poseFallbackStarted = false;
    poseBitmapFailureCount = 0;
    poseWorkerFailureCount = 0;
    nextPoseWorkerFrameId = 1;
    lastSubmittedVideoTime = -1;
    lastPoseCaptureAt = 0;
    if (poseWorkerInitializationTimer !== null) {
        clearTimeout(poseWorkerInitializationTimer);
        poseWorkerInitializationTimer = null;
    }
    if (poseWorker) {
        poseWorker.terminate();
        poseWorker = null;
    }
    if (pose && typeof pose.close === 'function') {
        try {
            pose.close();
        } catch (error) {
            console.warn('Unable to close pose pipeline cleanly:', error);
        }
    }
    pose = null;
    resetPoseTrackingState();
}

function showPosePipelineError(error) {
    console.error('Pose tracking unavailable:', error);
    loader.style.display = 'none';
    cameraPermission.style.display = 'block';
    const title = cameraPermission.querySelector('h3');
    const message = cameraPermission.querySelector('p');
    if (title) title.textContent = 'Pose Tracking Unavailable';
    if (message) {
        message.textContent =
            'Please update the app or browser and restart the exercise.';
    }
}

function isAppleMobileDevice() {
    const userAgent = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const iOSUserAgent = /iPad|iPhone|iPod/i.test(userAgent);
    const iPadDesktopMode =
        platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const mobileWebKit =
        /AppleWebKit/i.test(userAgent)
        && /Mobile\//i.test(userAgent)
        && !/Android/i.test(userAgent);
    return iOSUserAgent || iPadDesktopMode || mobileWebKit;
}

async function initializeLegacyPose(reason) {
    if (
        posePipelineMode === 'legacy'
        || poseFallbackStarted
        || !exerciseActive
    ) {
        return;
    }

    poseFallbackStarted = true;
    const generation = ++posePipelineGeneration;
    console.warn('Switching to mobile-compatible MediaPipe Pose:', reason);
    cancelPoseFrameLoop();
    poseFrameInFlight = false;
    poseWorkerReady = false;
    if (poseWorkerInitializationTimer !== null) {
        clearTimeout(poseWorkerInitializationTimer);
        poseWorkerInitializationTimer = null;
    }
    if (poseWorker) {
        poseWorker.terminate();
        poseWorker = null;
    }
    pose = null;
    posePipelineMode = 'none';
    resetPoseTrackingState();

    try {
        if (cameraDiagnosticMode === 'pose') {
            await loadRuntimeScript(
                LEGACY_POSE_URL,
                () => typeof window.Pose === 'function'
            );
        } else {
            await loadLegacyPoseRuntime();
        }
        if (typeof window.Pose !== 'function') {
            throw new Error('Legacy MediaPipe Pose failed to load.');
        }

        const legacyPose = new window.Pose({
            locateFile: (file) => `${LEGACY_POSE_BASE}/${file}`
        });
        legacyPose.setOptions({
            // Use MediaPipe's balanced defaults on iOS. A lite model
            // plus higher confidence can reject a valid person in
            // lower-light front-camera frames.
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });
        legacyPose.onResults((results) => {
            if (generation !== posePipelineGeneration || pose !== legacyPose || !exerciseActive) return;
            poseFrameInFlight = false;
            if (legacyDiagnosticTrace) {
                legacyDiagnosticTrace.inferenceCompletedAt = poseDiagnostics.epoch();
            }
            poseDiagnostics?.received(legacyDiagnosticTrace, Boolean(results.poseLandmarks), results.poseLandmarks);
            onPoseResults(
                results,
                legacyDiagnosticTrace,
                performance.now()
            );
        });

        pose = legacyPose;
        posePipelineMode = 'legacy';
        poseDelegate = 'legacy-main-thread';
        poseDiagnostics?.configure({ pipeline: 'legacy', modelComplexity: 1,
            delegate: 'legacy-implementation-managed', smoothing: true });
        poseGpuFallbackReason = reason || null;
        console.info('MediaPipe Pose ready: mobile-compatible fallback');

        if (!camera) {
            await startCameraStream();
        } else {
            startPoseFrameLoop();
        }
    } catch (error) {
        if (generation !== posePipelineGeneration) return;
        posePipelineMode = 'none';
        pose = null;
        showPosePipelineError(error);
    } finally {
        if (generation === posePipelineGeneration) poseFallbackStarted = false;
    }
}

function getPoseAnalysisSize(sourceWidth, sourceHeight) {
    const longestSide = Math.max(sourceWidth, sourceHeight);
    if (!longestSide) {
        return null;
    }
    const maxDimension = poseDelegate === 'CPU'
        ? Math.min(256, POSE_ANALYSIS_MAX_DIMENSION)
        : POSE_ANALYSIS_MAX_DIMENSION;
    const scale = Math.min(1, maxDimension / longestSide);
    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale))
    };
}

function shouldCapturePersonRoi() {
    return (
        exerciseUsesPoseContinuityGate()
        && typeof shouldUseRoiCapture === 'function'
        && shouldUseRoiCapture()
    );
}

function buildPoseWorkerCropMeta(cropPixels, videoWidth, videoHeight) {
    if (!cropPixels || !videoWidth || !videoHeight) {
        return null;
    }
    return {
        x: cropPixels.x,
        y: cropPixels.y,
        width: cropPixels.width,
        height: cropPixels.height,
        videoWidth,
        videoHeight
    };
}

function remapPoseResultsFromInferenceCrop(results, cropMeta) {
    if (
        !results?.poseLandmarks?.length
        || !cropMeta
        || typeof remapLandmarksFromCrop !== 'function'
    ) {
        return results;
    }
    return {
        ...results,
        poseLandmarks: remapLandmarksFromCrop(
            results.poseLandmarks,
            cropMeta,
            cropMeta.videoWidth,
            cropMeta.videoHeight
        )
    };
}

function handlePoseRoiPersonLost() {
    resetPosePersonLock();
    personDetected = false;
    missingFrames = MISSING_THRESHOLD;
    wholeBodyDetected = false;
    latestFormOk = false;
    formValidationReceived = false;
    resetPoseTrackingState();
    handleNoPersonDetected();
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'no_person' }));
    }
    const overlayTitle = personDetectionOverlay?.querySelector?.('h2');
    const overlayText = personDetectionOverlay?.querySelector?.('p');
    if (overlayTitle) {
        overlayTitle.textContent = 'Position yourself';
    }
    if (overlayText) {
        overlayText.textContent = 'Step back into frame so your full upper body is visible.';
    }
    personDetectionOverlay?.classList?.add('active');
}

async function capturePoseAnalysisBitmap(timing = null) {
    const videoWidth = cameraStream.videoWidth;
    const videoHeight = cameraStream.videoHeight;
    let cropPixels = null;
    if (shouldCapturePersonRoi() && videoWidth && videoHeight) {
        cropPixels = getActivePersonCropPixels?.(videoWidth, videoHeight) || null;
    }
    if (timing) {
        timing.cropPixels = cropPixels;
    }

    if (poseDiagnostics && poseDebugOptions.get('poseCpuInput') === 'source') {
        const bitmapStartedAt = performance.now();
        const bitmap = cropPixels
            ? await createImageBitmap(
                cameraStream,
                cropPixels.x,
                cropPixels.y,
                cropPixels.width,
                cropPixels.height
            )
            : await createImageBitmap(cameraStream);
        const createImageBitmapMs = performance.now() - bitmapStartedAt;
        if (timing) {
            timing.drawImageMs = 0;
            timing.createImageBitmapMs = createImageBitmapMs;
            timing.captureMs = createImageBitmapMs;
            timing.capturePath = cropPixels ? 'roi-full' : 'video-full';
        }
        poseDiagnostics?.sample('drawImageMs', 0);
        poseDiagnostics?.sample('createImageBitmapMs', createImageBitmapMs);
        recordCaptureTiming(0, createImageBitmapMs);
        return bitmap;
    }

    const sourceWidth = cropPixels ? cropPixels.width : videoWidth;
    const sourceHeight = cropPixels ? cropPixels.height : videoHeight;
    const size = getPoseAnalysisSize(sourceWidth, sourceHeight);
    if (!size) {
        const bitmapStartedAt = performance.now();
        const bitmap = cropPixels
            ? await createImageBitmap(
                cameraStream,
                cropPixels.x,
                cropPixels.y,
                cropPixels.width,
                cropPixels.height
            )
            : await createImageBitmap(cameraStream);
        const createImageBitmapMs = performance.now() - bitmapStartedAt;
        if (timing) {
            timing.drawImageMs = 0;
            timing.createImageBitmapMs = createImageBitmapMs;
            timing.captureMs = createImageBitmapMs;
            timing.capturePath = cropPixels ? 'roi-full' : 'video-full';
        }
        poseDiagnostics?.sample('drawImageMs', 0);
        poseDiagnostics?.sample('createImageBitmapMs', createImageBitmapMs);
        recordCaptureTiming(0, createImageBitmapMs);
        return bitmap;
    }

    const resizeOptions = {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'low'
    };

    // One-shot resize avoids a main-thread drawImage + second bitmap copy.
    // Fall back to the tiny canvas path when resize options are rejected
    // (some Android WebViews) so analysis still stays downscaled.
    try {
        const bitmapStartedAt = performance.now();
        const bitmap = cropPixels
            ? await createImageBitmap(
                cameraStream,
                cropPixels.x,
                cropPixels.y,
                cropPixels.width,
                cropPixels.height,
                resizeOptions
            )
            : await createImageBitmap(cameraStream, resizeOptions);
        const createImageBitmapMs = performance.now() - bitmapStartedAt;
        if (timing) {
            timing.drawImageMs = 0;
            timing.createImageBitmapMs = createImageBitmapMs;
            timing.captureMs = createImageBitmapMs;
            timing.capturePath = cropPixels ? 'roi-resize' : 'video-resize';
        }
        poseDiagnostics?.sample('drawImageMs', 0);
        poseDiagnostics?.sample('createImageBitmapMs', createImageBitmapMs);
        recordCaptureTiming(0, createImageBitmapMs);
        return bitmap;
    } catch (resizeError) {
        poseDiagnostics?.event?.('captureResizeFallback', {
            message: resizeError?.message || String(resizeError)
        });
    }

    if (!poseCaptureCanvas) {
        poseCaptureCanvas = document.createElement('canvas');
        poseCaptureCtx = poseCaptureCanvas.getContext('2d', {
            alpha: false,
            desynchronized: true
        });
    }
    if (
        poseCaptureCanvas.width !== size.width
        || poseCaptureCanvas.height !== size.height
    ) {
        poseCaptureCanvas.width = size.width;
        poseCaptureCanvas.height = size.height;
        poseCaptureCtx = poseCaptureCanvas.getContext('2d', {
            alpha: false,
            desynchronized: true
        });
    }
    const drawStartedAt = performance.now();
    if (cropPixels) {
        poseCaptureCtx.drawImage(
            cameraStream,
            cropPixels.x,
            cropPixels.y,
            cropPixels.width,
            cropPixels.height,
            0,
            0,
            size.width,
            size.height
        );
    } else {
        poseCaptureCtx.drawImage(cameraStream, 0, 0, size.width, size.height);
    }
    const drawImageMs = performance.now() - drawStartedAt;
    const bitmapStartedAt = performance.now();
    const bitmap = await createImageBitmap(poseCaptureCanvas);
    const createImageBitmapMs = performance.now() - bitmapStartedAt;
    if (timing) {
        timing.drawImageMs = drawImageMs;
        timing.createImageBitmapMs = createImageBitmapMs;
        timing.captureMs = drawImageMs + createImageBitmapMs;
        timing.capturePath = cropPixels ? 'roi-canvas' : 'canvas';
    }
    poseDiagnostics?.sample('drawImageMs', drawImageMs);
    poseDiagnostics?.sample('createImageBitmapMs', createImageBitmapMs);
    recordCaptureTiming(drawImageMs, createImageBitmapMs);
    return bitmap;
}

function recordCaptureTiming(drawImageMs, createImageBitmapMs) {
    if (!cameraMetricsState) return;
    cameraMetricsState.captureCount =
        (cameraMetricsState.captureCount || 0) + 1;
    cameraMetricsState.drawImageTotalMs =
        (cameraMetricsState.drawImageTotalMs || 0) + drawImageMs;
    cameraMetricsState.createImageBitmapTotalMs =
        (cameraMetricsState.createImageBitmapTotalMs || 0)
        + createImageBitmapMs;
    const drawSamples = cameraMetricsState.drawImageSamples
        || (cameraMetricsState.drawImageSamples = []);
    const bitmapSamples = cameraMetricsState.createImageBitmapSamples
        || (cameraMetricsState.createImageBitmapSamples = []);
    drawSamples.push(drawImageMs);
    bitmapSamples.push(createImageBitmapMs);
    if (drawSamples.length > 600) drawSamples.shift();
    if (bitmapSamples.length > 600) bitmapSamples.shift();
}

function percentile95(values) {
    if (!values?.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function averageOf(values) {
    if (!values?.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clearPendingPoseWorkerSubmission() {
    if (!pendingPoseWorkerSubmission) return;
    pendingPoseWorkerSubmission.frame?.close?.();
    pendingPoseWorkerSubmission = null;
}

function postPoseWorkerSubmission(submission, worker = poseWorker) {
    if (!worker || !submission?.frame) return false;
    worker.postMessage(
        {
            type: 'frame',
            protocolVersion: POSE_WORKER_PROTOCOL_VERSION,
            frameId: submission.frameId,
            frame: submission.frame,
            timestampMs: submission.timestampMs,
            mediaTime: submission.mediaTime,
            captureMs: submission.captureMs,
            ...(submission.cropPixels
                ? { cropPixels: submission.cropPixels }
                : {}),
            ...(submission.diagnosticTrace
                ? { diagnosticTrace: submission.diagnosticTrace }
                : {})
        },
        [submission.frame]
    );
    poseWorkerInferenceBusy = true;
    poseDiagnostics?.count('submitted');
    return true;
}

function flushPendingPoseWorkerSubmission() {
    const pending = pendingPoseWorkerSubmission;
    if (!pending || !poseWorker || !exerciseActive) return;
    pendingPoseWorkerSubmission = null;
    try {
        postPoseWorkerSubmission(pending);
    } catch (error) {
        pending.frame?.close?.();
        handlePoseWorkerFailure({
            stage: 'inference',
            message: error?.message || 'Unable to submit pending pose frame'
        });
    } finally {
        pending.frame = null;
    }
}

function shouldSkipPoseCaptureForBudget(now = performance.now()) {
    if (!(poseCaptureIntervalMs > 0)) return false;
    if (now - lastPoseCaptureAt < poseCaptureIntervalMs) {
        poseDiagnostics?.count('analysisRateSkips');
        return true;
    }
    return false;
}

async function submitPoseFrame(timestampMs, mediaTime, metadata) {
    const pipelineReady =
        (
            posePipelineMode === 'worker'
            && poseWorkerReady
            && poseWorker
        )
        || (
            posePipelineMode === 'legacy'
            && pose
        );
    if (
        !exerciseActive
        || !pipelineReady
        || poseFrameInFlight
        || cameraStream.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || !cameraStream.videoWidth
        || !cameraStream.videoHeight
    ) {
        if (poseFrameInFlight) {
            posePerformanceMonitor.skipped();
            poseDiagnostics?.count('busySkips');
            poseDiagnostics?.event('skipped', {
                reason: POSE_AB_MODE === 'b' ? 'captureBusy' : 'inferenceBusy',
                mediaTime,
            });
        }
        return false;
    }
    if (
        Number.isFinite(mediaTime)
        && mediaTime === lastSubmittedVideoTime
    ) {
        return false;
    }
    const captureClockMs = performance.now();
    if (shouldSkipPoseCaptureForBudget(captureClockMs)) {
        return false;
    }
    poseFrameInFlight = true;
    lastPoseCaptureAt = captureClockMs;
    const generation = posePipelineGeneration;
    const frameWorker = poseWorker;
    const diagnosticTrace = poseDiagnostics?.begin(timestampMs, metadata);
    if (Number.isFinite(mediaTime)) {
        lastSubmittedVideoTime = mediaTime;
    }

    if (posePipelineMode === 'legacy') {
        try {
            if (!ensurePoseCanvasMatchesVideo()) {
                return false;
            }
            legacyDiagnosticTrace = diagnosticTrace;
            if (diagnosticTrace) {
                diagnosticTrace.submittedAt = poseDiagnostics.epoch();
                diagnosticTrace.inferenceStartedAt = diagnosticTrace.submittedAt;
            }
            poseDiagnostics?.count('submitted');
            await pose.send({ image: cameraStream });
            return true;
        } catch (error) {
            if (generation !== posePipelineGeneration) return false;
            console.error('Legacy pose inference failed:', error);
            showPosePipelineError(error);
            return false;
        } finally {
            if (generation === posePipelineGeneration) poseFrameInFlight = false;
        }
    }

    let frame = null;
    try {
        if (generation !== posePipelineGeneration || frameWorker !== poseWorker || !exerciseActive) {
            poseDiagnostics?.count('obsoleteCaptureDrops');
            return false;
        }
        const captureTiming = {};
        frame = await capturePoseAnalysisBitmap(captureTiming);
        const captureMs = captureTiming.captureMs ?? (
            (captureTiming.drawImageMs || 0)
            + (captureTiming.createImageBitmapMs || 0)
        );
        if (diagnosticTrace) {
            diagnosticTrace.captureMs = captureMs;
            diagnosticTrace.drawImageMs = captureTiming.drawImageMs;
            diagnosticTrace.createImageBitmapMs = captureTiming.createImageBitmapMs;
        }
        // Bitmap creation can finish after stop/restart or a fallback.
        // Such a frame must not enter the replacement pipeline.
        if (generation !== posePipelineGeneration || frameWorker !== poseWorker || !exerciseActive) {
            poseDiagnostics?.count('obsoleteCaptureDrops');
            return false;
        }
        const cropPixels = buildPoseWorkerCropMeta(
            captureTiming.cropPixels,
            cameraStream.videoWidth,
            cameraStream.videoHeight
        );
        const frameId = nextPoseWorkerFrameId++;
        poseDiagnostics?.configure({ analysisWidth: frame.width, analysisHeight: frame.height });
        if (diagnosticTrace) diagnosticTrace.submittedAt = poseDiagnostics.epoch();
        if (POSE_AB_MODE === 'b' && poseWorkerInferenceBusy) {
            if (pendingPoseWorkerSubmission) {
                pendingPoseWorkerSubmission.frame?.close?.();
                poseDiagnostics?.count('workerBusyDrops');
                poseDiagnostics?.event('dropped', {
                    reason: 'workerCoalesced',
                    mediaTime: pendingPoseWorkerSubmission.mediaTime,
                });
            }
            pendingPoseWorkerSubmission = {
                frameId,
                frame,
                timestampMs,
                mediaTime,
                captureMs,
                cropPixels,
                diagnosticTrace,
            };
            frame = null;
            poseFrameInFlight = false;
            poseBitmapFailureCount = 0;
            return true;
        }
        postPoseWorkerSubmission({
            frameId,
            frame,
            timestampMs,
            mediaTime,
            captureMs,
            cropPixels,
            diagnosticTrace
        }, frameWorker);
        frame = null; // Ownership transferred; the worker closes it.
        poseBitmapFailureCount = 0;
        if (POSE_AB_MODE === 'b') {
            poseFrameInFlight = false;
        }
        return true;
    } catch (error) {
        if (generation !== posePipelineGeneration) return false;
        poseFrameInFlight = false;
        poseBitmapFailureCount += 1;
        console.error('Unable to prepare pose frame:', error);
        if (poseBitmapFailureCount >= MAX_POSE_PIPELINE_FAILURES) {
            initializeLegacyPose(
                error?.message || 'createImageBitmap is unavailable'
            );
        }
        return false;
    } finally {
        // Includes stale captures and postMessage failures.
        frame?.close?.();
    }
}

function isPoseFrameLoopActive() {
    const pipelineReady =
        (
            posePipelineMode === 'worker'
            && poseWorkerReady
        )
        || (
            posePipelineMode === 'legacy'
            && pose
        );
    return Boolean(exerciseActive && camera && pipelineReady);
}

function isCaptureOnlyFrameLoopActive() {
    return Boolean(
        exerciseActive
        && camera
        && cameraDiagnosticMode === 'capture'
    );
}

function ensureCameraFrameLoops() {
    if (poseFrameLoopController && captureOnlyFrameLoopController) return;
    if (typeof createCameraFrameLoop !== 'function') {
        throw new Error('Pose frame-loop runtime is unavailable.');
    }

    poseFrameLoopController = createCameraFrameLoop({
        video: cameraStream,
        isActive: isPoseFrameLoopActive,
        // Some WKWebView versions expose camera-backed callbacks that do not
        // fire reliably, so Apple mobile keeps the animation-frame fallback.
        useVideoFrameCallback: () => !isAppleMobileDevice(),
        onFrame(now, metadata) {
            if (metadata) {
                poseDiagnostics?.videoFrame(metadata);
            } else {
                poseDiagnostics?.count('animationCallbacks');
            }
            // A live WKWebView video may report a fixed currentTime. The
            // in-flight guard, rather than media-time de-duplication, protects
            // the animation-frame path from overlapping inference.
            return submitPoseFrame(
                now,
                metadata ? Number(metadata.mediaTime) : undefined,
                metadata
            );
        }
    });

    captureOnlyFrameLoopController = createCameraFrameLoop({
        video: cameraStream,
        isActive: isCaptureOnlyFrameLoopActive,
        useVideoFrameCallback: () => !isAppleMobileDevice(),
        onFrame: runCaptureOnlySample
    });
}

function startPoseFrameLoop() {
    cancelPoseFrameLoop();
    lastSubmittedVideoTime = -1;
    lastPoseCaptureAt = 0;
    ensureCameraFrameLoops();
    poseFrameLoopController.start();
}

async function runCaptureOnlySample(now, metadata) {
    poseDiagnostics?.videoFrame(metadata);
    if (captureOnlyInFlight) {
        poseDiagnostics?.count('busySkips');
        return;
    }
    if (shouldSkipPoseCaptureForBudget(now)) {
        return;
    }
    if (
        cameraStream.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || !cameraStream.videoWidth
        || !cameraStream.videoHeight
    ) {
        return;
    }
    captureOnlyInFlight = true;
    lastPoseCaptureAt = now;
    let bitmap = null;
    try {
        const captureTiming = {};
        const diagnosticTrace = poseDiagnostics?.begin(now, metadata);
        bitmap = await capturePoseAnalysisBitmap(captureTiming);
        if (diagnosticTrace) {
            diagnosticTrace.captureMs = captureTiming.captureMs;
            diagnosticTrace.drawImageMs = captureTiming.drawImageMs;
            diagnosticTrace.createImageBitmapMs = captureTiming.createImageBitmapMs;
            diagnosticTrace.submittedAt = poseDiagnostics.epoch();
            // Capture-only closes immediately; treat close as a synthetic result.
            diagnosticTrace.inferenceStartedAt = diagnosticTrace.submittedAt;
            diagnosticTrace.inferenceCompletedAt = poseDiagnostics.epoch();
            poseDiagnostics.received(diagnosticTrace, false, null);
        }
        poseDiagnostics?.count('submitted');
    } catch (error) {
        console.error('Capture-only diagnostic failed:', error);
    } finally {
        bitmap?.close?.();
        captureOnlyInFlight = false;
    }
}

function startCaptureOnlyLoop() {
    cancelPoseFrameLoop();
    lastPoseCaptureAt = 0;
    exerciseActive = true;
    ensureCameraFrameLoops();
    captureOnlyFrameLoopController.start();
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        cancelPoseFrameLoop();
    } else if (
        exerciseActive
        && camera
        && cameraDiagnosticMode === 'capture'
    ) {
        startCaptureOnlyLoop();
    } else if (
        exerciseActive
        && camera
        && (
            (posePipelineMode === 'worker' && poseWorkerReady)
            || (posePipelineMode === 'legacy' && pose)
        )
    ) {
        startPoseFrameLoop();
    }
});

function reportPosePerformance(windowMetrics) {
    const metrics = {
        model: POSE_MODEL_VARIANT,
        delegate: poseDelegate,
        ...windowMetrics,
        gpuFallback: Boolean(poseGpuFallbackReason)
    };
    console.info('Pose performance', metrics);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'client_performance',
            ...metrics
        }));
    }
}

function selectCameraCapabilities(capabilities) {
    if (!capabilities) return null;
    return Object.fromEntries([
        'width', 'height', 'frameRate', 'aspectRatio', 'facingMode', 'resizeMode'
    ].filter(name => capabilities[name] !== undefined)
        .map(name => [name, capabilities[name]]));
}

function formatCameraNumber(value, digits = 1) {
    return Number.isFinite(value) ? Number(value).toFixed(digits) : 'unavailable';
}

function updateCameraMetricsOutput() {
    if (!cameraMetricsState || !cameraDiagnosticsOutput) return;
    const state = cameraMetricsState;
    const now = performance.now();
    const elapsedSeconds = Math.max(0.001, (now - state.startedAt) / 1000);
    const callbackElapsedSeconds = state.lastCallbackAt !== null
        ? Math.max(0.001, (state.lastCallbackAt - state.firstCallbackAt) / 1000)
        : 0;
    const callbackFps = state.callbackCount > 1
        ? (state.callbackCount - 1) / callbackElapsedSeconds
        : null;
    const presentedFps =
        Number.isFinite(state.firstPresentedFrame)
        && Number.isFinite(state.lastPresentedFrame)
        && callbackElapsedSeconds > 0
            ? (state.lastPresentedFrame - state.firstPresentedFrame) / callbackElapsedSeconds
            : null;
    const settings = state.track.getSettings();
    const playbackQuality = typeof cameraStream.getVideoPlaybackQuality === 'function'
        ? cameraStream.getVideoPlaybackQuality()
        : null;
    const droppedFrames = Number.isFinite(playbackQuality?.droppedVideoFrames)
        ? playbackQuality.droppedVideoFrames
        : null;
    const totalFrames = Number.isFinite(playbackQuality?.totalVideoFrames)
        ? playbackQuality.totalVideoFrames
        : null;
    const droppedPercent = droppedFrames !== null && totalFrames > 0
        ? droppedFrames * 100 / totalFrames
        : null;
    const mainThreadLoadPercent = Math.min(
        100,
        state.longTaskDurationMs * 100 / Math.max(1, now - state.startedAt)
    );
    const expectedFps = Number(settings.frameRate) || null;
    const enoughData = elapsedSeconds >= 3 && presentedFps !== null;
    const deliveryLooksChoppy = enoughData && (
        (expectedFps && presentedFps < expectedFps * 0.8)
        || (droppedPercent !== null && droppedPercent > 5)
        || mainThreadLoadPercent > 20
    );
    const deliveryAssessment = !enoughData
        ? 'collecting (minimum 3 seconds)'
        : deliveryLooksChoppy
            ? 'choppy indicators detected'
            : 'frame delivery stable; confirm visual smoothness manually';
    const poseReport = poseDiagnostics?.report();
    const posePipeline = poseReport?.pipeline;
    const latency = poseReport?.latency;
    const captureFps = state.captureCount > 0
        ? state.captureCount / elapsedSeconds
        : posePipeline?.analysisSubmissionFps ?? null;
    const drawImageAvg = averageOf(state.drawImageSamples)
        ?? latency?.drawImageMs?.average
        ?? null;
    const drawImageP95 = percentile95(state.drawImageSamples)
        ?? latency?.drawImageMs?.p95
        ?? null;
    const createBitmapAvg = averageOf(state.createImageBitmapSamples)
        ?? latency?.createImageBitmapMs?.average
        ?? null;
    const createBitmapP95 = percentile95(state.createImageBitmapSamples)
        ?? latency?.createImageBitmapMs?.p95
        ?? null;
    const onPoseTotalAvg = latency?.onPoseResultsTotalMs?.average ?? null;
    const onPoseCanvasAvg = latency?.onPoseResultsCanvasMs?.average ?? null;
    const onPoseUiAvg = latency?.onPoseResultsUiMs?.average ?? null;
    const onPoseSendAvg = latency?.onPoseResultsSendMs?.average ?? null;

    cameraDiagnosticsOutput.textContent = [
        `Stage: ${state.mode.toUpperCase()}`,
        `Pose capture interval: ${poseCaptureIntervalMs} ms`
            + ` (requested ${requestedPoseIntervalMs ?? 'default'
            } / default ${DEFAULT_POSE_CAPTURE_INTERVAL_MS})`,
        'Requested: 480x360 ideal (640x480 max), 30 FPS ideal (30 max)',
        `30 FPS profile: ${state.thirtyFpsStatus}`,
        `Capabilities: ${JSON.stringify(state.capabilities)}`,
        `Actual resolution: ${settings.width || cameraStream.videoWidth}x${settings.height || cameraStream.videoHeight}`,
        `Actual track FPS: ${formatCameraNumber(Number(settings.frameRate))}`,
        `requestVideoFrameCallback FPS: ${formatCameraNumber(callbackFps)}`,
        `Presented FPS: ${formatCameraNumber(presentedFps)}`,
        `Capture FPS: ${formatCameraNumber(captureFps)}`,
        `Dropped video frames: ${droppedFrames ?? 'unavailable'}${droppedPercent === null ? '' : ` (${droppedPercent.toFixed(2)}%)`}`,
        `Main-thread long-task load: ${mainThreadLoadPercent.toFixed(2)}% (${state.longTaskCount} tasks)`,
        `drawImage avg / P95 ms: ${formatCameraNumber(drawImageAvg, 2)} / ${formatCameraNumber(drawImageP95, 2)}`,
        `createImageBitmap avg / P95 ms: ${formatCameraNumber(createBitmapAvg, 2)} / ${formatCameraNumber(createBitmapP95, 2)}`,
        `Pose submission FPS: ${formatCameraNumber(posePipeline?.analysisSubmissionFps)}`,
        `Pose result FPS: ${formatCameraNumber(posePipeline?.poseResultFps)}`,
        `Inference avg / P95 ms: ${formatCameraNumber(latency?.inferenceMs?.average, 2)} / ${formatCameraNumber(latency?.inferenceMs?.p95, 2)}`,
        `Result age avg / P95 ms: ${formatCameraNumber(latency?.observedToLandmarkMs?.average, 2)} / ${formatCameraNumber(latency?.observedToLandmarkMs?.p95, 2)}`,
        `Canvas draw FPS: ${formatCameraNumber(poseReport?.fps.draws)}`,
        `Keypoint FPS: ${formatCameraNumber(posePipeline?.keypointFps)}`,
        `Busy skips / rate skips: ${poseReport?.counts?.busySkips ?? 0} / ${poseReport?.counts?.analysisRateSkips ?? 0}`,
        `onPoseResults total/canvas/ui/send avg ms: ${formatCameraNumber(onPoseTotalAvg, 2)} / ${formatCameraNumber(onPoseCanvasAvg, 2)} / ${formatCameraNumber(onPoseUiAvg, 2)} / ${formatCameraNumber(onPoseSendAvg, 2)}`,
        `Assessment: ${deliveryAssessment}`,
        'Visual smoothness: observe the live preview; this cannot be inferred from counters alone.'
    ].join('\n');
}

function stopCameraMetrics() {
    if (
        cameraMetricsFrameCallback !== null
        && typeof cameraStream.cancelVideoFrameCallback === 'function'
    ) {
        cameraStream.cancelVideoFrameCallback(cameraMetricsFrameCallback);
    }
    cameraMetricsFrameCallback = null;
    if (cameraMetricsInterval !== null) clearInterval(cameraMetricsInterval);
    cameraMetricsInterval = null;
    cameraLongTaskObserver?.disconnect();
    cameraLongTaskObserver = null;
    cameraMetricsState = null;
}

function startCameraMetrics(track, capabilities, thirtyFpsStatus) {
    stopCameraMetrics();
    cameraDiagnosticsPanel.hidden = false;
    cameraMetricsState = {
        mode: cameraDiagnosticMode || 'full',
        track,
        capabilities,
        thirtyFpsStatus,
        startedAt: performance.now(),
        callbackCount: 0,
        firstCallbackAt: null,
        lastCallbackAt: null,
        firstPresentedFrame: null,
        lastPresentedFrame: null,
        longTaskCount: 0,
        longTaskDurationMs: 0,
        captureCount: 0,
        drawImageTotalMs: 0,
        createImageBitmapTotalMs: 0,
        drawImageSamples: [],
        createImageBitmapSamples: []
    };

    if (
        typeof PerformanceObserver === 'function'
        && PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
        cameraLongTaskObserver = new PerformanceObserver((list) => {
            if (!cameraMetricsState) return;
            for (const entry of list.getEntries()) {
                cameraMetricsState.longTaskCount += 1;
                cameraMetricsState.longTaskDurationMs += entry.duration;
            }
        });
        cameraLongTaskObserver.observe({ type: 'longtask', buffered: true });
    }

    if (typeof cameraStream.requestVideoFrameCallback === 'function') {
        const observeFrame = (now, metadata) => {
            if (!cameraMetricsState) return;
            cameraMetricsState.callbackCount += 1;
            cameraMetricsState.firstCallbackAt ??= now;
            cameraMetricsState.lastCallbackAt = now;
            if (Number.isFinite(metadata?.presentedFrames)) {
                cameraMetricsState.firstPresentedFrame ??= metadata.presentedFrames;
                cameraMetricsState.lastPresentedFrame = metadata.presentedFrames;
            }
            cameraMetricsFrameCallback = cameraStream.requestVideoFrameCallback(observeFrame);
        };
        cameraMetricsFrameCallback = cameraStream.requestVideoFrameCallback(observeFrame);
    }
    cameraMetricsInterval = setInterval(updateCameraMetricsOutput, 1000);
    updateCameraMetricsOutput();
}

async function applyStableThirtyFpsProfile(track, capabilities) {
    if (!requestStableThirtyFps) return 'not requested';
    const range = capabilities?.frameRate;
    if (
        !range
        || !Number.isFinite(range.min)
        || !Number.isFinite(range.max)
        || range.min > 24
        || range.max < 30
    ) {
        return 'not applied; track capabilities do not include 24–30 FPS';
    }
    try {
        await track.applyConstraints({
            frameRate: { ideal: 30, min: 24, max: 30 }
        });
        return 'applied after capability check (ideal 30, min 24, max 30)';
    } catch (error) {
        return `applyConstraints failed: ${error?.message || String(error)}`;
    }
}

async function initializeIsolatedCameraDiagnostic() {
    document.body.classList.remove('picker-active');
    document.body.classList.add(
        'exercise-active',
        'camera-diagnostic',
        `camera-stage-${cameraDiagnosticMode}`
    );
    exerciseView.style.display = 'flex';
    exerciseView.classList.add('active');
    cameraDiagnosticsPanel.hidden = false;
    cameraPermission.style.display = 'none';
    loader.style.display = 'flex';
    const loaderText = loader.querySelector('p');
    if (loaderText) loaderText.textContent = `Starting ${cameraDiagnosticMode} diagnostic…`;

    try {
        if (
            cameraDiagnosticMode === 'camera'
            || cameraDiagnosticMode === 'callback'
        ) {
            await startCameraStream({ poseEnabled: false });
        } else if (cameraDiagnosticMode === 'capture') {
            poseDiagnostics?.configure({
                pipeline: 'capture-only',
                analysisThrottleMs: poseCaptureIntervalMs,
                poseCaptureIntervalMs
            });
            await startCameraStream({ poseEnabled: false });
            startCaptureOnlyLoop();
            loader.style.display = 'none';
        } else {
            exerciseActive = true;
            await initializeMediaPipe();
        }
    } catch (error) {
        loader.style.display = 'none';
        cameraPermission.style.display = 'block';
        cameraDiagnosticsOutput.textContent = `Camera diagnostic failed: ${error?.message || String(error)}`;
    }
}

async function startCameraStream({ poseEnabled = true } = {}) {
    if (camera) return;

    const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: CAMERA_VIDEO_CONSTRAINTS
    });
    const videoTrack = mediaStream.getVideoTracks()[0];
    const trackCapabilities = typeof videoTrack?.getCapabilities === 'function'
        ? selectCameraCapabilities(videoTrack.getCapabilities())
        : null;
    const thirtyFpsStatus = await applyStableThirtyFpsProfile(
        videoTrack,
        trackCapabilities
    );
    if (poseEnabled) bindCameraDimensionSync();
    cameraStream.srcObject = mediaStream;
    cameraStream.playsInline = true;
    cameraStream.setAttribute('playsinline', '');
    cameraStream.setAttribute('webkit-playsinline', '');
    cameraStream.muted = true;
    await cameraStream.play();
    const trackSettings = videoTrack?.getSettings();
    poseDiagnostics?.configure({ camera: trackSettings ? {
        width: trackSettings.width, height: trackSettings.height,
        frameRate: trackSettings.frameRate, facingMode: trackSettings.facingMode
    } : null, cameraCapabilities: trackCapabilities,
    requestedCameraConstraints: CAMERA_VIDEO_CONSTRAINTS,
    thirtyFpsStatus, userAgent: navigator.userAgent });
    const dimensionsReady = await waitForCameraDimensions();
    if (!dimensionsReady) {
        console.warn(
            'Camera dimensions unavailable after timeout; pose overlay may misalign'
        );
    }

    camera = {
        stop() {
            cancelPoseFrameLoop();
            stopCameraMetrics();
            if (poseEnabled) unbindCameraDimensionSync();
            mediaStream.getTracks().forEach((track) => track.stop());
            cameraStream.srcObject = null;
        }
    };
    if (cameraMetricsEnabled) {
        startCameraMetrics(videoTrack, trackCapabilities, thirtyFpsStatus);
    }
    if (poseEnabled) startPoseFrameLoop();
    else {
        loader.style.display = 'none';
    }
    console.log('Camera settings:', trackSettings);
    console.log('Camera started successfully', {
        videoWidth: cameraStream.videoWidth,
        videoHeight: cameraStream.videoHeight,
        trackSettings,
        trackCapabilities
    });

    if (poseEnabled) setTimeout(() => {
        if (!firstPoseResultReceived) {
            loader.style.display = 'none';
        }
    }, 5000);
}

function handlePoseWorkerFailure({
    stage,
    message,
    forceFallback = false
}) {
    poseFrameInFlight = false;
    poseWorkerInferenceBusy = false;
    clearPendingPoseWorkerSubmission();
    if (stage === 'initialization' || forceFallback) {
        clearTimeout(poseWorkerInitializationTimer);
        poseWorkerInitializationTimer = null;
    }
    console.error(`Pose worker ${stage} error:`, message);
    poseWorkerFailureCount += 1;
    if (
        forceFallback
        || stage === 'initialization'
        || poseWorkerFailureCount >= MAX_POSE_PIPELINE_FAILURES
    ) {
        initializeLegacyPose(message || `Worker ${stage} failed`);
    }
}

// Initialize the supported MediaPipe Tasks Pose Landmarker in a worker.
async function initializeMediaPipe() {
    if (poseWorker || pose || poseFallbackStarted) return;

    // WKWebView can expose Worker/createImageBitmap even when video
    // ImageBitmaps do not produce reliable frames for Tasks Vision.
    // Feed the HTMLVideoElement directly to MediaPipe on Apple mobile
    // devices; Android keeps the faster worker pipeline.
    if (isAppleMobileDevice()) {
        await initializeLegacyPose('Using the iOS-compatible video pipeline');
        return;
    }

    if (
        typeof Worker !== 'function'
        || typeof createImageBitmap !== 'function'
    ) {
        await initializeLegacyPose(
            'Web Worker or createImageBitmap is unavailable'
        );
        return;
    }

    // Tasks Vision's WASM bootstrap relies on importScripts(), so the
    // worker must remain classic even though its bundle is imported dynamically.
    const workerUrl = new URL('./pose-worker.js', document.baseURI);
    try {
        poseWorker = new Worker(workerUrl);
    } catch (error) {
        initializeLegacyPose(error?.message || 'Pose worker could not start');
        return;
    }
    posePipelineMode = 'worker';
    pose = poseWorker;
    const generation = ++posePipelineGeneration;
    const activeWorker = poseWorker;

    poseWorker.onmessage = (event) => {
        if (generation !== posePipelineGeneration || activeWorker !== poseWorker || !exerciseActive) return;
        const message = event.data || {};
        if (message.protocolVersion !== POSE_WORKER_PROTOCOL_VERSION) {
            handlePoseWorkerFailure({
                stage: message.type === 'ready' ? 'initialization' : 'inference',
                message: `Unsupported pose-worker protocol: ${message.protocolVersion}`,
                forceFallback: true
            });
            return;
        }
        if (message.type === 'ready') {
            if (poseWorkerInitializationTimer !== null) {
                clearTimeout(poseWorkerInitializationTimer);
                poseWorkerInitializationTimer = null;
            }
            poseDelegate = message.delegate || 'unknown';
            poseDiagnostics?.configure({ pipeline: 'worker', model: POSE_MODEL_URL,
                delegate: poseDelegate, gpuFallbackReason: message.gpuFallbackReason || null,
                processingLandmarks: 'raw',
                analysisThrottleMs: poseCaptureIntervalMs,
                poseCaptureIntervalMs,
                poseAbMode: POSE_AB_MODE,
                tasksRunningMode: 'VIDEO',
                poseModelVariant: POSE_MODEL_VARIANT,
                detectionConfidence: POSE_TASK_DETECTION_CONFIDENCE,
                presenceConfidence: POSE_TASK_PRESENCE_CONFIDENCE,
                trackingConfidence: POSE_TASK_TRACKING_CONFIDENCE,
                trackingLandmarkConfidence: TRACKING_POSE_CONFIDENCE,
                formLandmarkConfidence: FORM_POSE_CONFIDENCE,
                poseConfProfile: requestedPoseConfProfile || 'c-default' });
            poseGpuFallbackReason = message.gpuFallbackReason || null;
            posePerformanceMonitor.reset();
            console.info(`Pose Landmarker ready: ${POSE_MODEL_VARIANT} model, ${poseDelegate} delegate`);
            if (poseGpuFallbackReason) {
                console.warn(
                    'Pose GPU unavailable; using downscaled CPU input:',
                    poseGpuFallbackReason
                );
            }
            poseWorkerReady = true;
            poseWorkerFailureCount = 0;
            startCameraStream().catch((error) => {
                console.error('Camera error:', error);
                loader.style.display = 'none';
                cameraPermission.style.display = 'block';
            });
            return;
        }
        if (message.type === 'result') {
            poseWorkerInferenceBusy = false;
            if (POSE_AB_MODE !== 'b') {
                poseFrameInFlight = false;
            } else {
                flushPendingPoseWorkerSubmission();
            }
            poseDiagnostics?.received(message.diagnosticTrace, Boolean(message.landmarks), message.landmarks);
            const captureMs = Number(message.captureMs) || 0;
            const inferenceMs = Number(message.inferenceMs) || 0;
            const resultAgeMs = Math.max(
                0,
                performance.now() - Number(message.timestampMs || 0)
            );
            posePerformanceMonitor.record({
                captureMs,
                inferenceMs,
                resultAgeMs
            });
            onPoseResults(
                remapPoseResultsFromInferenceCrop(
                    {
                        poseLandmarks: message.landmarks,
                        poseWorldLandmarks: message.worldLandmarks
                    },
                    message.cropPixels
                ),
                message.diagnosticTrace,
                message.timestampMs,
                message.mediaTime
            );
            return;
        }
        if (message.type === 'error') {
            handlePoseWorkerFailure({
                stage: message.stage || 'inference',
                message: message.message
            });
        }
    };
    poseWorker.onerror = (error) => {
        if (generation !== posePipelineGeneration || activeWorker !== poseWorker || !exerciseActive) return;
        handlePoseWorkerFailure({
            stage: 'runtime',
            message: error?.message || 'Pose worker failed to load',
            forceFallback: true
        });
    };
    poseWorker.postMessage({
        type: 'init',
        protocolVersion: POSE_WORKER_PROTOCOL_VERSION,
        modelUrl: POSE_MODEL_URL,
        landmarkerOptions: {
            minPoseDetectionConfidence: POSE_TASK_DETECTION_CONFIDENCE,
            minPosePresenceConfidence: POSE_TASK_PRESENCE_CONFIDENCE,
            minTrackingConfidence: POSE_TASK_TRACKING_CONFIDENCE
        }
    });
    poseWorkerInitializationTimer = setTimeout(() => {
        if (generation === posePipelineGeneration && !poseWorkerReady && posePipelineMode === 'worker') {
            initializeLegacyPose('Pose worker initialization timed out');
        }
    }, 8000);
}

function isShoulderRaiseExercise() {
    return [
        'shoulder_front_raise_rules',
        'shoulder_lateral_raise_rules',
        'shoulder front raise',
        'shoulder lateral raise'
    ].includes(exerciseName);
}

const shoulderRaiseFailureLabels = Object.freeze({
    incomplete_raise: 'Elbows did not reach the dotted height line',
    incomplete_lower: 'Arms did not return fully to the bottom',
    elbow_moved_sideways: 'Elbow kept moving sideways during the rep',
    arm_not_lateral: 'Raise the arm out to the side',
    body_swing: 'Torso moved or swung during the rep',
    inactive_arm_moved: 'The resting arm moved too much',
    both_arms_moved_in_single_mode: 'Both arms moved in single-arm mode',
    both_arms_moved_in_alternating_mode: 'Raise only one arm at a time',
    same_arm_repeated: 'Use the opposite arm for the next rep',
    wrong_arm_used: 'The unselected arm was raised',
    uneven_bilateral_movement: 'Both arms did not move evenly',
    movement_too_fast: 'The rep was too fast to count',
    landmark_visibility_low: 'The required arm landmarks left the frame',
    invalid_start_position: 'Begin with the arms fully lowered',
    not_standing: 'Stand upright before starting'
});

function formatShoulderRaiseFailure(reason) {
    if (!reason) {
        return 'No failed rep';
    }
    return shoulderRaiseFailureLabels[reason]
        || reason
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function drawShoulderRaiseHeightGuide(canvasCtx, landmarks) {
    if (!isShoulderRaiseExercise() || !landmarks?.length) {
        return;
    }

    const requiredShoulderIndices = multiModeMode === 'single'
        ? [multiModeSelectedSide === 'right' ? 12 : 11]
        : [11, 12];
    const shoulders = requiredShoulderIndices
        .map((index) => landmarks[index])
        .filter((landmark) =>
            landmark
            && (landmark.visibility ?? 1) >= 0.55
            && Number.isFinite(landmark.y)
        );
    if (shoulders.length !== requiredShoulderIndices.length) {
        return;
    }

    const canvasWidth = poseCanvas.width;
    const canvasHeight = poseCanvas.height;
    const displayedCanvasWidth = poseCanvas.getBoundingClientRect().width;
    const scale = displayedCanvasWidth > 0
        ? canvasWidth / displayedCanvasWidth
        : Math.max(0.8, canvasWidth / 640);
    const rawTargetY = Math.max(
        34 * scale,
        Math.min(
            canvasHeight - 34 * scale,
            shoulders.reduce((total, shoulder) => total + shoulder.y, 0)
            / shoulders.length
            * canvasHeight
        )
    );
    const guideSmoothing = multiModeMode === 'bilateral' ? 0.18 : 0.28;
    const maximumGuideStep = (multiModeMode === 'bilateral' ? 6 : 9) * scale;
    if (shoulderRaiseGuideY === null) {
        shoulderRaiseGuideY = rawTargetY;
    } else {
        const smoothedDelta =
            (rawTargetY - shoulderRaiseGuideY) * guideSmoothing;
        const boundedDelta = Math.max(
            -maximumGuideStep,
            Math.min(maximumGuideStep, smoothedDelta)
        );
        shoulderRaiseGuideY += boundedDelta;
    }
    const targetY = shoulderRaiseGuideY;
    const lineStartX = canvasWidth * 0.06;
    const lineEndX = canvasWidth * 0.94;
    const guideColor = '#FFD54A';

    canvasCtx.save();
    canvasCtx.beginPath();
    canvasCtx.setLineDash([10 * scale, 8 * scale]);
    canvasCtx.lineDashOffset = 0;
    canvasCtx.strokeStyle = guideColor;
    canvasCtx.lineWidth = 3 * scale;
    canvasCtx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    canvasCtx.shadowBlur = 5 * scale;
    canvasCtx.moveTo(lineStartX, targetY);
    canvasCtx.lineTo(lineEndX, targetY);
    canvasCtx.stroke();
    canvasCtx.restore();

}

function resetPoseTrackingState() {
    poseLandmarkSmoother.reset();
    resetPosePersonLock();
}

function drawPoseConnections(ctx, landmarks, connections, options = {}) {
    if (!landmarks?.length) return;

    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const threshold = options.confidence ?? DISPLAY_POSE_CONFIDENCE;

    ctx.save();
    ctx.strokeStyle = options.color || VALID_POSE_COLOR;
    ctx.lineWidth = options.lineWidth || SKELETON_CONNECTOR_STYLE.lineWidth;

    for (const [a, b] of connections) {
        const p1 = landmarks[a];
        const p2 = landmarks[b];
        if (!p1 || !p2) continue;
        if (
            getPoseConfidence(p1) < threshold
            || getPoseConfidence(p2) < threshold
        ) {
            continue;
        }
        if (
            !Number.isFinite(p1.x)
            || !Number.isFinite(p1.y)
            || !Number.isFinite(p2.x)
            || !Number.isFinite(p2.y)
        ) {
            continue;
        }
        ctx.beginPath();
        ctx.moveTo(p1.x * width, p1.y * height);
        ctx.lineTo(p2.x * width, p2.y * height);
        ctx.stroke();
    }

    ctx.restore();
}

function drawSkeletonLandmarks(canvasCtx, landmarks, { color, fillColor, radius }) {
    if (!landmarks?.length) return;
    const width = canvasCtx.canvas.width;
    const height = canvasCtx.canvas.height;
    canvasCtx.fillStyle = fillColor || color;
    for (const index of SKELETON_LANDMARK_INDEXES) {
        const landmark = landmarks[index];
        if (!landmark || getPoseConfidence(landmark) < DISPLAY_POSE_CONFIDENCE) continue;
        if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) continue;
        canvasCtx.beginPath();
        canvasCtx.arc(
            landmark.x * width,
            landmark.y * height,
            radius,
            0,
            Math.PI * 2
        );
        canvasCtx.fill();
    }
}

function renderIsolatedCanvasDiagnostic(results, diagnosticTrace) {
    if (!ensurePoseCanvasMatchesVideo()) return;
    const canvasCtx = poseCanvas.getContext('2d');
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
    if (results.poseLandmarks) {
        const rawLandmarks = results.poseLandmarks;
        const landmarks = poseLandmarkSmoother.update(rawLandmarks);
        poseDiagnostics?.displayed(rawLandmarks, landmarks);
        drawPoseConnections(canvasCtx, landmarks, POSE_CONNECTIONS, {
            color: VALID_POSE_COLOR,
            ...SKELETON_CONNECTOR_STYLE,
            confidence: DISPLAY_POSE_CONFIDENCE
        });
        drawSkeletonLandmarks(canvasCtx, landmarks, {
            color: VALID_POSE_COLOR,
            fillColor: VALID_POSE_COLOR,
            ...SKELETON_LANDMARK_STYLE
        });
        poseDiagnostics?.drawn(diagnosticTrace);
    }
    canvasCtx.restore();
}

function landmarksToKeypoints(landmarks = []) {
    return landmarks.map((landmark) => [
        landmark.x,
        landmark.y,
        landmark.z || 0,
        getLandmarkVisibility(landmark)
    ]);
}

function renderPoseOverlay(canvasCtx, landmarks, bodyVisible, diagnosticTrace, rawLandmarks) {
    poseDiagnostics?.displayed(rawLandmarks, landmarks);
    if (hasDrawablePose(landmarks)) {
        const poseColor = bodyVisible && formValidationReceived && latestFormOk
            ? VALID_POSE_COLOR
            : INVALID_POSE_COLOR;
        drawPoseConnections(canvasCtx, landmarks, POSE_CONNECTIONS, {
            color: poseColor,
            ...SKELETON_CONNECTOR_STYLE,
            confidence: DISPLAY_POSE_CONFIDENCE
        });
        drawSkeletonLandmarks(canvasCtx, landmarks, {
            color: poseColor,
            fillColor: poseColor,
            ...SKELETON_LANDMARK_STYLE
        });
        if (bodyVisible) {
            drawShoulderRaiseHeightGuide(canvasCtx, landmarks);
        }
    }
    if (poseDiagnostics && exerciseUsesPoseContinuityGate()) {
        drawPersonRoiDebug?.(
            canvasCtx,
            cameraStream.videoWidth,
            cameraStream.videoHeight
        );
    }
    poseDiagnostics?.drawn(diagnosticTrace);
}

function sendPoseKeypoints({
    landmarks,
    worldLandmarks,
    bodyVisible,
    sendPoseToBackend,
    sendTimestampMs,
    mediaTime,
    diagnosticTrace
}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const sendClockMs = performance.now();
    const keypointSendDue =
        nextKeypointSendAt === null || sendClockMs >= nextKeypointSendAt;
    const websocketReady = ws.bufferedAmount < MAX_WEBSOCKET_BUFFER_BYTES;
    if (keypointSendDue && websocketReady && sendPoseToBackend) {
        const diagnostic = poseDiagnostics?.sent(
            diagnosticTrace,
            ws.bufferedAmount
        );
        ws.send(JSON.stringify({
            type: 'keypoints',
            keypoints: landmarksToKeypoints(landmarks),
            world_keypoints: landmarksToKeypoints(worldLandmarks),
            exercise: exerciseName,
            source_timestamp_ms: sendTimestampMs,
            timestamp: sendTimestampMs / 1000,
            ...(Number.isFinite(mediaTime) ? { media_time: mediaTime } : {}),
            ...(diagnostic ? { diagnostic } : {})
        }));
        nextKeypointSendAt = advanceKeypointDeadline(
            sendClockMs,
            nextKeypointSendAt
        );
    } else if (keypointSendDue && websocketReady) {
        poseDiagnostics?.count('poseContinuitySendSkips');
    } else {
        poseDiagnostics?.count(
            websocketReady ? 'sendCadenceSkips' : 'sendBufferSkips'
        );
    }

    // Soft notify once; server warns without wiping the active rep cycle.
    if (!bodyVisible && exerciseActive && !occlusionSent) {
        ws.send(JSON.stringify({ type: 'occlusion' }));
        occlusionSent = true;
    } else if (bodyVisible) {
        occlusionSent = false;
    }
}

function handleMissingPoseFrame() {
    missingFrames += 1;
    wholeBodyDetected = false;
    latestFormOk = false;
    formValidationReceived = false;
    updateWholeBodyDetectionUI(false, false);

    if (missingFrames < MISSING_THRESHOLD || !personDetected) return;
    personDetected = false;
    resetPoseTrackingState();
    handleNoPersonDetected();
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'no_person' }));
    }
}

// Process pose results
function onPoseResults(
    results,
    diagnosticTrace,
    sourceTimestampMs = null,
    mediaTime = null
) {
    const onPoseStartedAt = performance.now();
    let canvasMs = 0;
    let uiMs = 0;
    let sendMs = 0;

    if (!firstPoseResultReceived && results.poseLandmarks) {
        firstPoseResultReceived = true;
        loader.style.display = 'none';
        console.log('First pose result received, camera is ready', {
            imageLandmarks: results.poseLandmarks.length,
            worldLandmarks: results.poseWorldLandmarks?.length || 0
        });
    }

    if (cameraDiagnosticMode === 'pose') {
        poseDiagnostics?.sample(
            'onPoseResultsTotalMs',
            performance.now() - onPoseStartedAt
        );
        return;
    }
    if (cameraDiagnosticMode === 'canvas') {
        const canvasStartedAt = performance.now();
        renderIsolatedCanvasDiagnostic(results, diagnosticTrace);
        poseDiagnostics?.sample(
            'onPoseResultsCanvasMs',
            performance.now() - canvasStartedAt
        );
        poseDiagnostics?.sample(
            'onPoseResultsTotalMs',
            performance.now() - onPoseStartedAt
        );
        return;
    }

    let canvasCtx = null;
    try {
        if (!ensurePoseCanvasMatchesVideo()) {
            return;
        }

        canvasCtx = poseCanvas.getContext('2d');
        const sendTimestampMs = Number.isFinite(sourceTimestampMs)
            ? sourceTimestampMs
            : performance.now();

        const canvasStartedAt = performance.now();
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);

        if (results.poseLandmarks) {
            missingFrames = 0;
            const rawLandmarks = results.poseLandmarks;
            const rawWorldLandmarks = results.poseWorldLandmarks || [];

            // Keep the worker landmarks for person tracking and backend input.
            // Smooth only the displayed copy; the backend filters its own raw
            // measurements, avoiding two smoothing passes on the same frame.
            const landmarks = rawLandmarks;
            const displayLandmarks = poseLandmarkSmoother.update(rawLandmarks);

            if (exerciseUsesPoseContinuityGate()) {
                const roiUpdate = updatePosePersonRoiFromLandmarks?.(
                    landmarks,
                    {
                        minConfidence: FORM_POSE_CONFIDENCE,
                        now: performance.now()
                    }
                );
                if (roiUpdate?.phase === 'lost') {
                    handlePoseRoiPersonLost();
                    canvasMs = performance.now() - canvasStartedAt;
                    canvasCtx.restore();
                    return;
                }
            }

            const sendPoseToBackend = shouldSendPoseToBackend(rawLandmarks);
            if (!sendPoseToBackend) {
                poseDiagnostics?.count('poseContinuityRejects');
            }

            if (!personDetected) {
                const uiStartedAt = performance.now();
                personDetected = true;
                latestFormOk = false;
                formValidationReceived = false;
                setFormDisplay('CHECK');
                setFeedbackDisplay('Checking exercise posture');
                uiMs += performance.now() - uiStartedAt;
            }

            const bodyVisible = isWholeBodyVisible(landmarks);
            renderPoseOverlay(
                canvasCtx,
                displayLandmarks,
                bodyVisible,
                diagnosticTrace,
                rawLandmarks
            );
            canvasMs = performance.now() - canvasStartedAt;
            const uiStartedAt = performance.now();
            if (bodyVisible !== wholeBodyDetected) {
                wholeBodyDetected = bodyVisible;
                if (!bodyVisible) {
                    latestFormOk = false;
                    formValidationReceived = false;
                }
            }
            // Reconcile the prompt every frame so an interrupted CSS
            // transition or another UI reset cannot leave it hidden.
            updateWholeBodyDetectionUI(bodyVisible, true);
            uiMs += performance.now() - uiStartedAt;

            // Always keep sending keypoints while a person is detected.
            // Stopping the stream on partial occlusion (common at squat
            // depth when ankles flicker) was aborting in-progress reps.
            const sendStartedAt = performance.now();
            sendPoseKeypoints({
                landmarks,
                worldLandmarks: rawWorldLandmarks,
                bodyVisible,
                sendPoseToBackend,
                sendTimestampMs,
                mediaTime,
                diagnosticTrace
            });
            sendMs = performance.now() - sendStartedAt;

        } else {
            const uiStartedAt = performance.now();
            handleMissingPoseFrame();
            uiMs += performance.now() - uiStartedAt;
            canvasMs = performance.now() - canvasStartedAt;
        }

        canvasCtx.restore();
    } catch (error) {
        console.error('Error in onPoseResults:', error);
        if (canvasCtx) {
            try {
                canvasCtx.restore();
            } catch (e) {
                console.error('Error restoring canvas context:', e);
            }
        }
    } finally {
        poseDiagnostics?.sample('onPoseResultsCanvasMs', canvasMs);
        poseDiagnostics?.sample('onPoseResultsUiMs', uiMs);
        poseDiagnostics?.sample('onPoseResultsSendMs', sendMs);
        poseDiagnostics?.sample(
            'onPoseResultsTotalMs',
            performance.now() - onPoseStartedAt
        );
    }
}

// Update whole body detection UI
function updateWholeBodyDetectionUI(isVisible, hasPose = false) {
    if (isVisible) {
        personDetectionOverlay.classList.remove('active');
        overlayActive = false;
    } else {
        personDetectionOverlay.classList.add('active');
        if (noPersonText) {
            noPersonText.textContent = hasPose
                ? 'Person detected — adjust your position'
                : 'No person detected';
        }
        overlayActive = true;

        if (timerRunning && isPlankExercise) {
            stopTimer();
        }
    }
}

// Handle no person detected
function handleNoPersonDetected() {
    deadliftTrackingStarted = false;
    setFormDisplay('NO PERSON');
    setFeedbackDisplay('No person detected');

    if (timerRunning && isPlankExercise) {
        stopTimer();
    }
}

function initializeWebSocket() {
    const apiExercise = resolveExercise(exerciseName)?.apiName || exerciseName;
    const exerciseParam = apiExercise ? `&exercise=${apiExercise}` : '';
    const hammerParams = isMultiModeExercise(apiExercise)
        ? `&mode=${encodeURIComponent(multiModeMode)}&selected_side=${encodeURIComponent(multiModeSelectedSide)}`
        : '';
    const wsUrl = `${API_BASE_URL.replace(/^http/, 'ws')}/ws?session_id=${sessionId}${exerciseParam}${hammerParams}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected successfully');
        resetExerciseState();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            poseDiagnostics?.serverResult(data.pose_diagnostic);
            if (data.tracking_method && data.tracking_method !== lastTrackingMethod) {
                lastTrackingMethod = data.tracking_method;
                console.log(`Pose tracking method: ${data.tracking_method}`);
            }
            updateUI(data);
        } catch (error) {
            console.error("WebSocket parse error:", error);
        }
    };

    ws.onclose = (event) => {
        console.log('WebSocket closed', { code: event.code, reason: event.reason });

        if (exerciseActive) {
            console.log('Attempting to reconnect...');
            setTimeout(initializeWebSocket, 2000);
        }
    };

    ws.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

// Format time in MM:SS format
function formatTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Update timer display
function updateTimerDisplay() {
    if (isPlankExercise) {
        setRepDisplay(formatTime(elapsedTime), { time: true });
    }
}

// Start timer
function startTimer() {
    if (!isPlankExercise || timerRunning || overlayActive) return;

    timerRunning = true;
    lastTimerUpdate = Date.now();

    timerInterval = setInterval(() => {
        const now = Date.now();
        const deltaTime = now - lastTimerUpdate;
        elapsedTime += deltaTime;
        lastTimerUpdate = now;
        updateTimerDisplay();
    }, 100);
}

// Stop timer
function stopTimer() {
    if (!isPlankExercise || !timerRunning) return;

    timerRunning = false;
    clearInterval(timerInterval);
}
let feedbackFrameCount = 0;

// Update UI with exercise data
function syncBarbellPoseRoiRepLock(data) {
    if (!exerciseUsesPoseContinuityGate()) {
        setPoseRoiRepHardLock?.(false);
        return;
    }
    const phaseRaw = data?.phase ?? data?.movement_phase ?? data?.current_state ?? '';
    const phase = String(phaseRaw).toLowerCase();
    const repActive = new Set(['concentric', 'top', 'eccentric']).has(phase);
    setPoseRoiRepHardLock?.(repActive);
}

function updateUI(data) {
    syncBarbellPoseRoiRepLock(data);
    if (
        (data.exercise === 'deadlift'
            || exerciseName === 'deadlift_rules'
            || exerciseName === 'deadlift')
        && typeof data.tracking_started === 'boolean'
    ) {
        deadliftTrackingStarted = data.tracking_started;
    }

    if (data.exercise) {
        const mobileExerciseName = document.getElementById('exercise-name-mobile');
        if (mobileExerciseName) {
            mobileExerciseName.textContent = data.exercise;
        }
    }

    if (
        ['shoulder front raise', 'shoulder lateral raise'].includes(data.exercise)
        || ['shoulder_front_raise_rules', 'shoulder_lateral_raise_rules'].includes(exerciseName)
    ) {
        const details = document.getElementById('front-raise-details');
        if (details) details.hidden = false;
        const lateralRaise =
            data.exercise === 'shoulder lateral raise'
            || exerciseName === 'shoulder_lateral_raise_rules';
        const leftShoulder = lateralRaise
            ? data.left_shoulder_abduction_angle
            : data.left_shoulder_flexion_angle;
        const rightShoulder = lateralRaise
            ? data.right_shoulder_abduction_angle
            : data.right_shoulder_flexion_angle;
        const frontRaiseValues = {
            'front-raise-left-elevation': leftShoulder == null
                ? (data.left_arm_elevation == null ? '—' : data.left_arm_elevation.toFixed(2))
                : `${Math.round(leftShoulder)}°`,
            'front-raise-right-elevation': rightShoulder == null
                ? (data.right_arm_elevation == null ? '—' : data.right_arm_elevation.toFixed(2))
                : `${Math.round(rightShoulder)}°`,
            'front-raise-left-elbow': data.left_elbow_angle == null
                ? '—'
                : `${Math.round(data.left_elbow_angle)}°`,
            'front-raise-right-elbow': data.right_elbow_angle == null
                ? '—'
                : `${Math.round(data.right_elbow_angle)}°`,
            'front-raise-left-reps': data.left_rep_count ?? 0,
            'front-raise-right-reps': data.right_rep_count ?? 0,
            'front-raise-pairs': data.completed_pairs ?? 0,
            'front-raise-state': data.current_state || 'not_ready',
            'front-raise-invalid': formatShoulderRaiseFailure(
                data.last_invalid_rep_reason
            )
        };
        setDetailValues(frontRaiseValues);
    }

    if (data.exercise === 'romanian_deadlift' || exerciseName === 'romanian_deadlift_rules') {
        const details = document.getElementById('rdl-details');
        if (details) details.hidden = false;
        const rdlValues = {
            'rdl-tracking-side': data.tracking_side || '—',
            'rdl-side-visibility': data.tracking_side_visibility == null
                ? '—'
                : Number(data.tracking_side_visibility).toFixed(2),
            'rdl-camera-view': data.camera_view || 'unknown',
            'rdl-hip-angle': data.hip_angle == null
                ? '—'
                : `${Math.round(data.hip_angle)}°`,
            'rdl-knee-angle': data.knee_angle == null
                ? '—'
                : `${Math.round(data.knee_angle)}°`,
            'rdl-torso-angle': data.torso_angle == null
                ? '—'
                : `${Math.round(data.torso_angle)}°`,
            'rdl-side-ratio': data.side_view_ratio == null
                ? '—'
                : Number(data.side_view_ratio).toFixed(2),
            'rdl-side-alignment': data.side_view_alignment == null
                ? '—'
                : Number(data.side_view_alignment).toFixed(2),
            'rdl-state': data.current_state || 'not_ready',
            'rdl-invalid': data.last_invalid_rep_reason || 'None'
        };
        setDetailValues(rdlValues);
    }

    if (data.exercise === 'hammer_curl' || exerciseName === 'hammer_curl_rules') {
        const details = document.getElementById('hammer-details');
        if (details) details.hidden = false;
        const hammerValues = {
            'hammer-left-angle': data.left_elbow_angle == null
                ? '—'
                : `${Math.round(data.left_elbow_angle)}°`,
            'hammer-right-angle': data.right_elbow_angle == null
                ? '—'
                : `${Math.round(data.right_elbow_angle)}°`,
            'hammer-left-reps': data.left_rep_count ?? 0,
            'hammer-right-reps': data.right_rep_count ?? 0,
            'hammer-pairs': data.completed_pairs ?? 0,
            'hammer-total': data.total_arm_movements ?? 0,
            'hammer-state': data.current_state || 'not_ready',
            'hammer-invalid': data.last_invalid_rep_reason || 'None'
        };
        setDetailValues(hammerValues);
    }

    // Handle timer for plank exercises
    if (isPlankExercise && data.feedback !== undefined) {
        const feedbackTextLower = data.feedback.toLowerCase();
        const isValidPlankFeedback = validPlankFeedbacks.some(feedback =>
            feedbackTextLower.includes(feedback.toLowerCase())
        );

        if (isValidPlankFeedback && !overlayActive) {
            if (!timerRunning) {
                startTimer();
            }
        } else {
            if (timerRunning) {
                stopTimer();
            }
        }
    }

    // IMMEDIATE REP VOICE 
    if (data.reps !== undefined && !isPlankExercise) {
        const multiModeActive =
            isMultiModeExercise(data.exercise)
            || isMultiModeExercise(exerciseName);
        const showAlternatingArmCounts = multiModeActive && (
            data.mode === 'alternating' || multiModeMode === 'alternating'
        );
        const displayedReps = showAlternatingArmCounts
            ? `${data.left_rep_count ?? 0} | ${data.right_rep_count ?? 0}`
            : data.reps;

        // Keep alternating arm counters separate instead of
        // showing their summed movement count.
        const displayedRepsText = String(displayedReps);
        if (displayedRepsText !== lastDisplayedReps) {
            lastDisplayedReps = displayedRepsText;
            setRepDisplay(displayedRepsText, {
                alternating: showAlternatingArmCounts,
                pulse: true
            });
        }
    }

    if (data.form_ok !== undefined) {
        // Ignore delayed "good" responses while required landmarks
        // are currently outside the frame. A fresh in-frame response
        // must arrive before the skeleton can turn green again.
        formValidationReceived = wholeBodyDetected;
        latestFormOk = wholeBodyDetected && data.form_ok === true;
        if (personDetected) {
            const statusText = data.form_ok ? "OK" : "FIX";

            if (statusText !== lastFormStatus) {
                lastFormStatus = statusText;
                setFormDisplay(statusText, data.form_ok === true);
            }
        }
    }

    // FEEDBACK VOICE - Speak when feedback changes
    feedbackFrameCount += 1;
    if (data.feedback !== undefined) {
        if (personDetected) {
            const currentFeedback = data.feedback || "No feedback yet";

            // Always update the UI text immediately
            if (currentFeedback !== lastFeedbackText) {
                lastFeedbackText = currentFeedback;
                setFeedbackDisplay(currentFeedback, { animate: true });
                // check after every 3 feedback even if there are 200 feedback
                if (feedbackFrameCount % 3 === 0 && !isPlankExercise) {
                    feedbackVoice.speak(currentFeedback + " Total reps are " + data.reps);

                    // feedbackVoice.speak(currentFeedback+ " Total reps are " +data.reps);
                } else if (isPlankExercise && feedbackFrameCount % 6 === 0) {
                    feedbackVoice.speak(currentFeedback + " time is " + formatTime(elapsedTime));
                }

                // USE FEEDBACK VOICE for form feedback
                console.log(` FEEDBACK CHANGED: Calling feedbackVoice.speak("${currentFeedback}")`);
                // feedbackVoice.speak(currentFeedback+ " Total reps are " +data.reps);
            }
        }
    }
}

// Stop exercise function
let exerciseStopped = false;
function stopExercise() {
    notifyNativeApp({ event: "stop_exercise" });
    if (exerciseStopped) return;
    exerciseStopped = true;
    exerciseActive = false;

    feedbackVoice.stop();

    if (timerRunning) {
        stopTimer();
    }

    if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, "Exercise stopped by user");
        }
        ws = null;
    }

    personDetectionOverlay.classList.remove('active');

    if (camera) {
        camera.stop();
        camera = null;
    }
    stopPosePipeline();

    fetch(`${API_BASE_URL}/stop?session_id=${sessionId}`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' }
    })
        .then(response => {
            console.log('Stop API response:', response);
            return response.json();
        })
        .catch(error => console.error('Error stopping exercise:', error))
        .finally(() => {
            exerciseStopped = false;
            sessionId = null;
            clearSessionUrl();
            showExercisePicker();
        });
}
