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
const poseDiagnostics = window.createPoseDiagnostics?.(
    cameraMetricsEnabled ? '?poseDebug=1' : window.location.search
);
window.poseDiagnostics = poseDiagnostics;
window.__poseScheduler = {
    intervalMs: poseCaptureIntervalMs,
    defaultIntervalMs: DEFAULT_POSE_CAPTURE_INTERVAL_MS,
    requestedIntervalMs: requestedPoseIntervalMs
};
let legacyDiagnosticTrace = null;
// Prefer Full on desktop GPU paths for stabler joints; keep Lite on
// Apple mobile (legacy) and when explicitly requested for weak devices.
const requestedPoseModel = poseDebugOptions.get('poseModel');
const POSE_MODEL_VARIANT = requestedPoseModel === 'lite'
    ? 'lite'
    : requestedPoseModel === 'full'
        ? 'full'
        : (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
            ? 'lite'
            : 'full');
const BACKEND_URL = 'https://yalla-ai.onlinetestingserver.com';
const API_BASE_URL = `${BACKEND_URL}/v1/exercise`;
const POSE_MODEL_URL =
    `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${POSE_MODEL_VARIANT}/float16/latest/pose_landmarker_${POSE_MODEL_VARIANT}.task`;
const DRAWING_UTILS_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js';
const LEGACY_POSE_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js';
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

function loadDrawingUtils() {
    return loadRuntimeScript(
        DRAWING_UTILS_URL,
        () => typeof window.drawConnectors === 'function'
            && typeof window.drawLandmarks === 'function'
    );
}

async function loadLegacyPoseRuntime() {
    await Promise.all([
        loadDrawingUtils(),
        loadRuntimeScript(LEGACY_POSE_URL, () => typeof window.Pose === 'function')
    ]);
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
// Elbows + wrists need higher display speed so curls do not trail
// along the forearm toward the elbow.
const FAST_DISPLAY_LANDMARK_INDEXES = Object.freeze(
    new Set([13, 14, 15, 16])
);

const frontendAssetUrl = (path) =>
    new URL(path, document.baseURI).href;

const exerciseIcons = {
    'barbell_biceps_curl_rules': frontendAssetUrl('./images/exercises/barbel-curls.png'),
    'hammer_curl_rules': frontendAssetUrl('./images/exercises/hammercurl.png'),
    'shoulder_front_raise_rules': frontendAssetUrl('./images/exercises/shoulderfrontraises.png'),
    'shoulder_lateral_raise_rules': frontendAssetUrl('./images/exercises/literal_raises.png'),
    'squat_rules': frontendAssetUrl('./images/exercises/squat.png'),
    'pushup_rules': frontendAssetUrl('./images/exercises/pushups.png'),
    'plank_rules': frontendAssetUrl('./images/exercises/plank.png'),
    'deadlift_rules': frontendAssetUrl('./images/exercises/deadlift.png?v=2'),
    'romanian_deadlift_rules': frontendAssetUrl('./images/exercises/deadlift.png?v=2'),
    'leg_raise_rules': frontendAssetUrl('./images/exercises/leg-raises.png')
};

const exerciseDisplayNames = {
    'barbell_biceps_curl_rules': 'Barbell Biceps Curl',
    'hammer_curl_rules': 'Hammer Curl',
    'shoulder_front_raise_rules': 'Shoulder Front Raises',
    'shoulder_lateral_raise_rules': 'Shoulder Lateral Raises',
    'squat_rules': 'Squat',
    'pushup_rules': 'Push-Up',
    'plank_rules': 'Plank',
    'deadlift_rules': 'Deadlift',
    'romanian_deadlift_rules': 'Romanian Deadlift',
    'leg_raise_rules': 'Lying Leg Raises'
};

const exerciseApiNames = {
    'barbell_biceps_curl_rules': 'barbell biceps curl',
    'hammer_curl_rules': 'hammer_curl',
    'shoulder_front_raise_rules': 'shoulder front raise',
    'shoulder_lateral_raise_rules': 'shoulder lateral raise',
    'squat_rules': 'squat',
    'pushup_rules': 'push-up',
    'plank_rules': 'plank',
    'deadlift_rules': 'deadlift',
    'romanian_deadlift_rules': 'romanian_deadlift',
    'leg_raise_rules': 'leg_raise'
};

const multiModeExerciseKeys = new Set([
    'hammer_curl_rules',
    'shoulder_front_raise_rules',
    'shoulder_lateral_raise_rules'
]);

function isMultiModeApiExercise(apiExercise) {
    return [
        'hammer_curl',
        'shoulder front raise',
        'shoulder lateral raise'
    ].includes(apiExercise);
}

function updateSessionUrl(id, exerciseKey) {
    const apiExercise = exerciseApiNames[exerciseKey] || exerciseKey;
    const params = new URLSearchParams({
        session_id: String(id),
        exercise: apiExercise
    });
    if (isMultiModeApiExercise(apiExercise)) {
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
    exerciseName = Object.entries(exerciseApiNames).find(
        ([, apiName]) => apiName === selectedExerciseKey
    )?.[0] || selectedExerciseKey;
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
    } else if (multiModeExerciseKeys.has(exerciseName)) {
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
    const apiExercise = exerciseApiNames[exerciseKey];
    if (!apiExercise) {
        showError('Invalid exercise selected.');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                exercise: apiExercise,
                mode: isMultiModeApiExercise(apiExercise) ? multiModeMode : 'single',
                selected_side: isMultiModeApiExercise(apiExercise)
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

    Object.entries(exerciseDisplayNames).forEach(([key, label]) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'exercise-card';
        card.innerHTML = `
            <img src="${exerciseIcons[key] || ''}" alt="${label}">
            <h3>${label}</h3>
        `;
        card.addEventListener('click', (event) => {
            event.currentTarget.blur();
            const config = document.getElementById('multi-mode-config');
            if (multiModeExerciseKeys.has(key)) {
                pendingMultiModeExerciseKey = key;
                document.getElementById('multi-mode-config-title').textContent =
                    `${exerciseDisplayNames[key]} Setup`;
                document.getElementById('start-multi-mode-exercise').textContent =
                    `Start ${exerciseDisplayNames[key]}`;
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
let posePipelineGeneration = 0;
let posePipelineMode = 'none';
let poseFallbackStarted = false;
let poseBitmapFailureCount = 0;
let poseWorkerFailureCount = 0;
let poseAnimationFrame = null;
let poseVideoFrameCallback = null;
let lastSubmittedVideoTime = -1;
let lastPoseCaptureAt = 0;
let captureOnlyInFlight = false;
let captureOnlyFrameCallback = null;
let captureOnlyAnimationFrame = null;
let poseCaptureCanvas = null;
let poseCaptureCtx = null;
let poseDelegate = 'unknown';
let poseGpuFallbackReason = null;
let posePerformanceSampleCount = 0;
let poseCaptureTotalMs = 0;
let poseInferenceTotalMs = 0;
let poseResultAgeTotalMs = 0;
let poseSkippedFrameCount = 0;
let posePerformanceWindowStartedAt = 0;
const POSE_PERFORMANCE_LOG_INTERVAL = 60;
const POSE_ANALYSIS_MAX_DIMENSION = 416;
const POSE_DRAW_MAX_DIMENSION = 640;
const MAX_POSE_PIPELINE_FAILURES = 2;
const CAMERA_VIDEO_CONSTRAINTS = Object.freeze({
    facingMode: 'user',
    width: { ideal: 480, max: 640 },
    height: { ideal: 360, max: 480 },
    frameRate: { ideal: 30, max: 30 }
});
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
const VALID_POSE_COLOR = '#00FF00';
const INVALID_POSE_COLOR = '#FF2D2D';
const SKELETON_CONNECTOR_STYLE = Object.freeze({ lineWidth: 1.5 });
const SKELETON_LANDMARK_STYLE = Object.freeze({
    lineWidth: 1,
    radius: 2
});
// null means no pose frame has confirmed visibility yet. Starting at
// false skipped the first "not visible" transition and hid the prompt.
let wholeBodyDetected = null;
let latestFormOk = false;
let formValidationReceived = false;
let occlusionSent = false;
let deadliftTrackingStarted = false;

// Camera ready flags
let cameraReady = false;
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
const exerciseIcon = document.getElementById('exercise-icon');
const overlayExerciseName = document.getElementById('overlay-exercise-name');
const noPersonText = document.getElementById('no-person-text');
const cameraDiagnosticsPanel = document.getElementById('camera-diagnostics');
const cameraDiagnosticsOutput = document.getElementById('camera-diagnostics-output');

console.log(' Exercise page loaded - initializing...', exerciseIcon);

// MediaPipe Tasks always includes visibility, while the legacy Pose
// result used by iOS/WKWebView can omit it. Keep the framing check and
// the keypoints sent to the backend on the same fallback semantics.
function getLandmarkVisibility(landmark) {
    if (landmark?.visibility != null) {
        const visibility = Number(landmark.visibility);
        if (Number.isFinite(visibility)) return visibility;
    }

    if (landmark?.presence != null) {
        const presence = Number(landmark.presence);
        if (Number.isFinite(presence)) return presence;
    }

    return 1.0;
}

function isLandmarkVisible(landmarks, index, threshold) {
    return (
        index < landmarks.length
        && getLandmarkVisibility(landmarks[index]) >= threshold
    );
}

// Check if whole body is visible
function isWholeBodyVisible(landmarks) {
    if (!landmarks || landmarks.length === 0) return false;

    const isMultiModeExercise = multiModeExerciseKeys.has(exerciseName);
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
    const keyPointIndices = isMultiModeExercise
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
        isMultiModeExercise ? 0.85 : bodyVisibilityThreshold
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
    errorDiv.style.position = 'fixed';
    errorDiv.style.top = '50%';
    errorDiv.style.left = '50%';
    errorDiv.style.transform = 'translate(-50%, -50%)';
    errorDiv.style.background = '#282828';
    errorDiv.style.color = 'white';
    errorDiv.style.padding = '20px';
    errorDiv.style.borderRadius = '10px';
    errorDiv.style.textAlign = 'center';
    errorDiv.style.zIndex = '1000';
    errorDiv.style.width = '80%';
    errorDiv.innerHTML = `<h3>Error</h3><p>${message}</p>`;

    document.body.appendChild(errorDiv);

    const closeButton = document.createElement('button');
    closeButton.textContent = 'Close';
    closeButton.style.marginTop = '20px';
    closeButton.style.backgroundColor = '#118076';
    closeButton.onclick = function () {
        notifyNativeApp({ event: "stop_exercise" });
        document.body.removeChild(errorDiv);
    };

    errorDiv.appendChild(closeButton);
}

// Reset exercise state
function resetExerciseState() {
    const showAlternatingArmCounts =
        multiModeExerciseKeys.has(exerciseName)
        && multiModeMode === 'alternating';
    repCounter.textContent = showAlternatingArmCounts ? "0 | 0" : "0";
    document.getElementById('counter-label').textContent =
        showAlternatingArmCounts ? "LEFT | RIGHT" : "REPS";
    formStatus.textContent = "CHECK";
    formStatus.className = "status bad";
    feedbackText.textContent = "No feedback yet";

    const mobileRepCounter = document.getElementById('rep-counter-mobile');
    const mobileFormStatus = document.getElementById('form-status-mobile');
    const mobileFeedbackText = document.getElementById('feedback-text-mobile');
    const mobileExerciseName = document.getElementById('exercise-name-mobile');

    if (mobileRepCounter) {
        mobileRepCounter.textContent = showAlternatingArmCounts ? "0 | 0" : "0";
    }
    const mobileCounterLabel = document.getElementById('counter-label-mobile');
    if (mobileCounterLabel) {
        mobileCounterLabel.textContent = showAlternatingArmCounts
            ? "Left | Right:"
            : "Reps:";
    }
    if (mobileFormStatus) {
        mobileFormStatus.textContent = "CHECK";
        mobileFormStatus.className = "bad";
    }
    if (mobileFeedbackText) mobileFeedbackText.textContent = "No feedback yet";
    if (mobileExerciseName) mobileExerciseName.textContent = exerciseDisplayNames[exerciseName] || "Exercise";

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
    if (exerciseIcons[exerciseName]) {
        exerciseIcon.src = exerciseIcons[exerciseName];
        exerciseIcon.alt = exerciseDisplayNames[exerciseName] + ' Icon';
    }
    if (overlayExerciseName) {
        overlayExerciseName.textContent = exerciseDisplayNames[exerciseName] || exerciseName;
    }

    for (const [id, value] of Object.entries({
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
    })) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }
}

// Show exercise view with animation
function showExerciseView() {
    exerciseView.style.display = 'flex';
    exerciseView.classList.add('active');
    loader.style.display = 'flex';
    cameraPermission.style.display = 'none';
    cameraReady = false;
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
    if (
        poseVideoFrameCallback !== null
        && typeof cameraStream.cancelVideoFrameCallback === 'function'
    ) {
        cameraStream.cancelVideoFrameCallback(poseVideoFrameCallback);
        poseVideoFrameCallback = null;
    }
    if (poseAnimationFrame !== null) {
        cancelAnimationFrame(poseAnimationFrame);
        poseAnimationFrame = null;
    }
    if (
        captureOnlyFrameCallback !== null
        && typeof cameraStream.cancelVideoFrameCallback === 'function'
    ) {
        cameraStream.cancelVideoFrameCallback(captureOnlyFrameCallback);
        captureOnlyFrameCallback = null;
    }
    if (captureOnlyAnimationFrame !== null) {
        cancelAnimationFrame(captureOnlyAnimationFrame);
        captureOnlyAnimationFrame = null;
    }
    captureOnlyInFlight = false;
}

function stopPosePipeline() {
    posePipelineGeneration += 1;
    cancelPoseFrameLoop();
    poseFrameInFlight = false;
    poseWorkerReady = false;
    posePipelineMode = 'none';
    poseFallbackStarted = false;
    poseBitmapFailureCount = 0;
    poseWorkerFailureCount = 0;
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
    resetAndroidPoseSmoothing();
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
    resetAndroidPoseSmoothing();

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
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
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
            onPoseResults(results, legacyDiagnosticTrace);
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

function getPoseAnalysisSize() {
    const sourceWidth = cameraStream.videoWidth;
    const sourceHeight = cameraStream.videoHeight;
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

async function capturePoseAnalysisBitmap(timing = null) {
    if (poseDiagnostics && poseDebugOptions.get('poseCpuInput') === 'source') {
        const bitmapStartedAt = performance.now();
        const bitmap = await createImageBitmap(cameraStream);
        const createImageBitmapMs = performance.now() - bitmapStartedAt;
        if (timing) {
            timing.drawImageMs = 0;
            timing.createImageBitmapMs = createImageBitmapMs;
            timing.captureMs = createImageBitmapMs;
            timing.capturePath = 'video-full';
        }
        poseDiagnostics?.sample('drawImageMs', 0);
        poseDiagnostics?.sample('createImageBitmapMs', createImageBitmapMs);
        recordCaptureTiming(0, createImageBitmapMs);
        return bitmap;
    }

    const size = getPoseAnalysisSize();
    if (!size) {
        const bitmapStartedAt = performance.now();
        const bitmap = await createImageBitmap(cameraStream);
        const createImageBitmapMs = performance.now() - bitmapStartedAt;
        if (timing) {
            timing.drawImageMs = 0;
            timing.createImageBitmapMs = createImageBitmapMs;
            timing.captureMs = createImageBitmapMs;
            timing.capturePath = 'video-full';
        }
        poseDiagnostics?.sample('drawImageMs', 0);
        poseDiagnostics?.sample('createImageBitmapMs', createImageBitmapMs);
        recordCaptureTiming(0, createImageBitmapMs);
        return bitmap;
    }

    // One-shot resize avoids a main-thread drawImage + second bitmap copy.
    // Fall back to the tiny canvas path when resize options are rejected
    // (some Android WebViews) so analysis still stays downscaled.
    try {
        const bitmapStartedAt = performance.now();
        const bitmap = await createImageBitmap(cameraStream, {
            resizeWidth: size.width,
            resizeHeight: size.height,
            resizeQuality: 'low'
        });
        const createImageBitmapMs = performance.now() - bitmapStartedAt;
        if (timing) {
            timing.drawImageMs = 0;
            timing.createImageBitmapMs = createImageBitmapMs;
            timing.captureMs = createImageBitmapMs;
            timing.capturePath = 'video-resize';
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
    poseCaptureCtx.drawImage(cameraStream, 0, 0, size.width, size.height);
    const drawImageMs = performance.now() - drawStartedAt;
    const bitmapStartedAt = performance.now();
    const bitmap = await createImageBitmap(poseCaptureCanvas);
    const createImageBitmapMs = performance.now() - bitmapStartedAt;
    if (timing) {
        timing.drawImageMs = drawImageMs;
        timing.createImageBitmapMs = createImageBitmapMs;
        timing.captureMs = drawImageMs + createImageBitmapMs;
        timing.capturePath = 'canvas';
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
            poseSkippedFrameCount += 1;
            poseDiagnostics?.count('busySkips');
            poseDiagnostics?.event('skipped', { reason: 'inferenceBusy', mediaTime });
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
        poseDiagnostics?.configure({ analysisWidth: frame.width, analysisHeight: frame.height });
        if (diagnosticTrace) diagnosticTrace.submittedAt = poseDiagnostics.epoch();
        frameWorker.postMessage(
            {
                type: 'frame',
                frame,
                timestampMs,
                mediaTime,
                captureMs,
                ...(diagnosticTrace ? { diagnosticTrace } : {})
            },
            [frame]
        );
        frame = null; // Ownership transferred; the worker closes it.
        poseDiagnostics?.count('submitted');
        poseBitmapFailureCount = 0;
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

function scheduleNextPoseFrame() {
    const pipelineReady =
        (
            posePipelineMode === 'worker'
            && poseWorkerReady
        )
        || (
            posePipelineMode === 'legacy'
            && pose
        );
    if (!exerciseActive || !camera || !pipelineReady) {
        return;
    }
    // requestVideoFrameCallback is exposed by some WKWebView versions
    // where camera-backed callbacks are unreliable. MediaPipe's
    // supported JS example uses an animation-driven camera loop, so
    // keep that compatible path for Apple mobile devices.
    if (
        !isAppleMobileDevice()
        && typeof cameraStream.requestVideoFrameCallback === 'function'
    ) {
        poseVideoFrameCallback =
            cameraStream.requestVideoFrameCallback(runPoseVideoFrameLoop);
    } else {
        poseAnimationFrame = requestAnimationFrame(runPoseAnimationFrameLoop);
    }
}

async function runPoseVideoFrameLoop(now, metadata) {
    poseVideoFrameCallback = null;
    poseDiagnostics?.videoFrame(metadata);
    // Keep the camera callback chain ahead of capture/inference work.
    scheduleNextPoseFrame();
    // Let the browser paint/composite the live <video> before main-thread
    // snapshot work when the Scheduling API is available.
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        try {
            await scheduler.yield();
        } catch (_) {
            // Ignore yield failures; capture proceeds immediately.
        }
    }
    submitPoseFrame(now, Number(metadata?.mediaTime), metadata);
}

function runPoseAnimationFrameLoop(timestampMs) {
    poseAnimationFrame = null;
    poseDiagnostics?.count('animationCallbacks');
    // A live getUserMedia video can report a fixed currentTime in
    // WKWebView. Do not de-duplicate RAF frames by media time; the
    // in-flight guard already prevents overlapping inference.
    scheduleNextPoseFrame();
    submitPoseFrame(timestampMs);
}

function startPoseFrameLoop() {
    cancelPoseFrameLoop();
    lastSubmittedVideoTime = -1;
    lastPoseCaptureAt = 0;
    scheduleNextPoseFrame();
}

function scheduleNextCaptureOnlyFrame() {
    if (!exerciseActive || !camera || cameraDiagnosticMode !== 'capture') {
        return;
    }
    if (
        !isAppleMobileDevice()
        && typeof cameraStream.requestVideoFrameCallback === 'function'
    ) {
        captureOnlyFrameCallback =
            cameraStream.requestVideoFrameCallback(runCaptureOnlyVideoFrameLoop);
    } else {
        captureOnlyAnimationFrame =
            requestAnimationFrame(runCaptureOnlyAnimationFrameLoop);
    }
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

async function runCaptureOnlyVideoFrameLoop(now, metadata) {
    captureOnlyFrameCallback = null;
    scheduleNextCaptureOnlyFrame();
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
        try {
            await scheduler.yield();
        } catch (_) {
            // Ignore yield failures; capture proceeds immediately.
        }
    }
    runCaptureOnlySample(now, metadata);
}

function runCaptureOnlyAnimationFrameLoop(timestampMs) {
    captureOnlyAnimationFrame = null;
    scheduleNextCaptureOnlyFrame();
    runCaptureOnlySample(timestampMs);
}

function startCaptureOnlyLoop() {
    cancelPoseFrameLoop();
    lastPoseCaptureAt = 0;
    exerciseActive = true;
    scheduleNextCaptureOnlyFrame();
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

function resetPosePerformanceWindow() {
    posePerformanceSampleCount = 0;
    poseCaptureTotalMs = 0;
    poseInferenceTotalMs = 0;
    poseResultAgeTotalMs = 0;
    poseSkippedFrameCount = 0;
    posePerformanceWindowStartedAt = performance.now();
}

function emitPosePerformanceTelemetry() {
    if (posePerformanceSampleCount < POSE_PERFORMANCE_LOG_INTERVAL) {
        return;
    }

    const elapsedMs = Math.max(
        1,
        performance.now() - posePerformanceWindowStartedAt
    );
    const metrics = {
        model: POSE_MODEL_VARIANT,
        delegate: poseDelegate,
        inputFps: Number(
            (
                posePerformanceSampleCount
                * 1000
                / elapsedMs
            ).toFixed(1)
        ),
        averageCaptureMs: Number(
            (
                poseCaptureTotalMs
                / posePerformanceSampleCount
            ).toFixed(1)
        ),
        averageInferenceMs: Number(
            (
                poseInferenceTotalMs
                / posePerformanceSampleCount
            ).toFixed(1)
        ),
        averageResultAgeMs: Number(
            (
                poseResultAgeTotalMs
                / posePerformanceSampleCount
            ).toFixed(1)
        ),
        skippedVideoFrames: poseSkippedFrameCount,
        gpuFallback: Boolean(poseGpuFallbackReason)
    };
    console.info('Pose performance', metrics);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'client_performance',
            ...metrics
        }));
    }
    resetPosePerformanceWindow();
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
            cameraReady = true;
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
        cameraReady = true;
    }
    console.log('Camera started successfully', {
        videoWidth: cameraStream.videoWidth,
        videoHeight: cameraStream.videoHeight,
        trackSettings,
        trackCapabilities
    });

    if (poseEnabled) setTimeout(() => {
        if (!firstPoseResultReceived) {
            loader.style.display = 'none';
            cameraReady = true;
        }
    }, 5000);
}

// Initialize the supported MediaPipe Tasks Pose Landmarker in a worker.
async function initializeMediaPipe() {
    if (poseWorker || pose || poseFallbackStarted) return;

    if (cameraDiagnosticMode !== 'pose') {
        try {
            await loadDrawingUtils();
        } catch (error) {
            showPosePipelineError(error);
            return;
        }
    }

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
        if (message.type === 'ready') {
            if (poseWorkerInitializationTimer !== null) {
                clearTimeout(poseWorkerInitializationTimer);
                poseWorkerInitializationTimer = null;
            }
            poseDelegate = message.delegate || 'unknown';
            poseDiagnostics?.configure({ pipeline: 'worker', model: POSE_MODEL_URL,
                delegate: poseDelegate, gpuFallbackReason: message.gpuFallbackReason || null,
                displaySmoothing: { ...ANDROID_DISPLAY_SMOOTHING },
                processingLandmarks: 'raw',
                analysisThrottleMs: poseCaptureIntervalMs,
                poseCaptureIntervalMs,
                detectionConfidence: 0.5, presenceConfidence: 0.5,
                trackingConfidence: 0.5 });
            poseGpuFallbackReason = message.gpuFallbackReason || null;
            resetPosePerformanceWindow();
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
            poseFrameInFlight = false;
            poseDiagnostics?.received(message.diagnosticTrace, Boolean(message.landmarks), message.landmarks);
            const captureMs = Number(message.captureMs) || 0;
            const inferenceMs = Number(message.inferenceMs) || 0;
            const resultAgeMs = Math.max(
                0,
                performance.now() - Number(message.timestampMs || 0)
            );
            if (posePerformanceSampleCount === 0) {
                posePerformanceWindowStartedAt = performance.now();
            }
            posePerformanceSampleCount += 1;
            poseCaptureTotalMs += captureMs;
            poseInferenceTotalMs += inferenceMs;
            poseResultAgeTotalMs += resultAgeMs;
            emitPosePerformanceTelemetry();
            onPoseResults({
                poseLandmarks: message.landmarks,
                poseWorldLandmarks: message.worldLandmarks
            }, message.diagnosticTrace);
            return;
        }
        if (message.type === 'error') {
            poseFrameInFlight = false;
            if (message.stage === 'initialization') {
                clearTimeout(poseWorkerInitializationTimer);
                poseWorkerInitializationTimer = null;
            }
            console.error(`Pose ${message.stage} error:`, message.message);
            poseWorkerFailureCount += 1;
            if (
                message.stage === 'initialization'
                || poseWorkerFailureCount >= MAX_POSE_PIPELINE_FAILURES
            ) {
                initializeLegacyPose(
                    message.message || `Worker ${message.stage} failed`
                );
            }
        }
    };
    poseWorker.onerror = (error) => {
        if (generation !== posePipelineGeneration || activeWorker !== poseWorker || !exerciseActive) return;
        poseFrameInFlight = false;
        clearTimeout(poseWorkerInitializationTimer);
        poseWorkerInitializationTimer = null;
        console.error('Pose worker error:', error.message || error);
        initializeLegacyPose(
            error?.message || 'Pose worker failed to load'
        );
    };
    poseWorker.postMessage({ type: 'init', modelUrl: POSE_MODEL_URL });
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

// Tasks Vision has no smoothLandmarks option. This filter is deliberately
// display-only: counting and visibility decisions use the raw worker result.
function createPoseSmoother({
    // Body-sync first: follow raw joints when visible; only hold the last
    // good point on dropout. Optional One Euro remains for explicit tests.
    followRaw = true,
    minCutoff = 5.5,
    beta = 1.2,
    derivateCutoff = 1,
    minVisibility = 0.4,
    resumeVisibility = 0.55,
    maxSpeed = Infinity,
    fastMaxSpeed = Infinity,
    fastLandmarkIndexes = null,
    now = () => performance.now()
} = {}) {
    let filters = null;
    let lastAtMs = null;
    const fastIndexes = fastLandmarkIndexes == null
        ? new Set([13, 14, 15, 16])
        : fastLandmarkIndexes;
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const axisValue = (value, axis, dt, speedLimit) => {
        if (!Number.isFinite(value)) return value;
        if (axis.hat == null) {
            axis.hat = value;
            axis.dHat = 0;
            return value;
        }
        const dValue = (value - axis.hat) / dt;
        axis.dHat += alpha(derivateCutoff, dt) * (dValue - axis.dHat);
        const cutoff = minCutoff + beta * Math.abs(axis.dHat);
        let next = axis.hat + alpha(cutoff, dt) * (value - axis.hat);
        if (Number.isFinite(speedLimit) && speedLimit > 0) {
            const maxStep = speedLimit * dt;
            const delta = next - axis.hat;
            if (delta > maxStep) next = axis.hat + maxStep;
            else if (delta < -maxStep) next = axis.hat - maxStep;
        }
        axis.hat = next;
        return axis.hat;
    };
    const rememberAxis = (value, axis) => {
        if (!Number.isFinite(value)) return;
        axis.hat = value;
        axis.dHat = 0;
    };
    return {
        reset() {
            filters = null;
            lastAtMs = null;
        },
        apply(landmarks) {
            if (!landmarks?.length) return landmarks;
            const clockMs = now();
            const dt = lastAtMs == null
                ? 1 / 30
                : Math.min(0.2, Math.max(1 / 120, (clockMs - lastAtMs) / 1000));
            lastAtMs = clockMs;
            if (!filters || filters.length !== landmarks.length) {
                filters = landmarks.map((landmark) => ({
                    x: { hat: null, dHat: 0 },
                    y: { hat: null, dHat: 0 },
                    z: { hat: null, dHat: 0 },
                    tracking: (landmark.visibility ?? 1) >= resumeVisibility
                }));
            }
            return landmarks.map((landmark, index) => {
                const axis = filters[index];
                const visibility = landmark.visibility ?? 1;
                // Hysteresis: once a joint drops out, require a clearer
                // reappearance before it can yank the drawn skeleton.
                if (axis.tracking) {
                    if (visibility < minVisibility) axis.tracking = false;
                } else if (visibility >= resumeVisibility) {
                    axis.tracking = true;
                }
                if (!axis.tracking) {
                    return {
                        x: axis.x.hat ?? landmark.x,
                        y: axis.y.hat ?? landmark.y,
                        z: axis.z.hat ?? (landmark.z || 0),
                        visibility,
                        presence: landmark.presence ?? 1
                    };
                }
                if (followRaw) {
                    rememberAxis(landmark.x, axis.x);
                    rememberAxis(landmark.y, axis.y);
                    rememberAxis(landmark.z || 0, axis.z);
                    return {
                        x: landmark.x,
                        y: landmark.y,
                        z: landmark.z || 0,
                        visibility,
                        presence: landmark.presence ?? 1
                    };
                }
                const speedLimit = fastIndexes?.has?.(index)
                    ? fastMaxSpeed
                    : maxSpeed;
                return {
                    x: axisValue(landmark.x, axis.x, dt, speedLimit),
                    y: axisValue(landmark.y, axis.y, dt, speedLimit),
                    z: axisValue(landmark.z || 0, axis.z, dt, speedLimit),
                    visibility,
                    presence: landmark.presence ?? 1
                };
            });
        }
    };
}

const ANDROID_DISPLAY_SMOOTHING = Object.freeze({
    followRaw: true,
    minCutoff: 5.5,
    beta: 1.2,
    derivateCutoff: 1,
    minVisibility: 0.4,
    resumeVisibility: 0.55,
    maxSpeed: Infinity,
    fastMaxSpeed: Infinity
});
const androidDisplayPoseSmoother = createPoseSmoother(
    ANDROID_DISPLAY_SMOOTHING
);

function resetAndroidPoseSmoothing() {
    androidDisplayPoseSmoother.reset();
}

function getPoseLandmarkViews(results) {
    const rawLandmarks = results.poseLandmarks;
    const rawWorldLandmarks = results.poseWorldLandmarks || [];
    const displayLandmarks =
        posePipelineMode === 'worker' && rawLandmarks
            ? androidDisplayPoseSmoother.apply(rawLandmarks)
            : rawLandmarks;

    // No current canvas element consumes world-space landmarks. Keep the
    // display view explicit without spending time filtering unused data.
    const displayWorldLandmarks = rawWorldLandmarks;
    return {
        rawLandmarks,
        displayLandmarks,
        rawWorldLandmarks,
        displayWorldLandmarks
    };
}

function drawSkeletonLandmarks(canvasCtx, landmarks, { color, fillColor, radius }) {
    if (!landmarks?.length) return;
    const width = canvasCtx.canvas.width;
    const height = canvasCtx.canvas.height;
    canvasCtx.fillStyle = fillColor || color;
    for (const index of SKELETON_LANDMARK_INDEXES) {
        const landmark = landmarks[index];
        if (!landmark || (landmark.visibility ?? 1) < 0.5) continue;
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
        const { rawLandmarks, displayLandmarks } = getPoseLandmarkViews(results);
        poseDiagnostics?.displayed(rawLandmarks, displayLandmarks);
        drawConnectors(canvasCtx, displayLandmarks, POSE_CONNECTIONS, {
            color: VALID_POSE_COLOR,
            ...SKELETON_CONNECTOR_STYLE
        });
        drawSkeletonLandmarks(canvasCtx, displayLandmarks, {
            color: VALID_POSE_COLOR,
            fillColor: VALID_POSE_COLOR,
            ...SKELETON_LANDMARK_STYLE
        });
        poseDiagnostics?.drawn(diagnosticTrace);
    }
    canvasCtx.restore();
}

// Process pose results
function onPoseResults(results, diagnosticTrace) {
    const onPoseStartedAt = performance.now();
    let canvasMs = 0;
    let uiMs = 0;
    let sendMs = 0;

    if (!firstPoseResultReceived && results.poseLandmarks) {
        firstPoseResultReceived = true;
        loader.style.display = 'none';
        cameraReady = true;
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
        const currentTimestamp = Date.now();

        const canvasStartedAt = performance.now();
        canvasCtx.save();
        canvasCtx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);

        if (results.poseLandmarks) {
            missingFrames = 0;
            const {
                rawLandmarks,
                displayLandmarks,
                rawWorldLandmarks
            } = getPoseLandmarkViews(results);

            if (!personDetected) {
                const uiStartedAt = performance.now();
                personDetected = true;
                latestFormOk = false;
                formValidationReceived = false;
                if (formStatus.textContent !== 'CHECK') {
                    formStatus.textContent = 'CHECK';
                }
                formStatus.className = 'status bad';
                if (feedbackText.textContent !== 'Checking exercise posture') {
                    feedbackText.textContent = 'Checking exercise posture';
                }
                uiMs += performance.now() - uiStartedAt;
            }

            const keypoints = rawLandmarks.map(landmark => [
                landmark.x,
                landmark.y,
                landmark.z || 0,
                getLandmarkVisibility(landmark)
            ]);
            const worldKeypoints = rawWorldLandmarks.map(landmark => [
                landmark.x,
                landmark.y,
                landmark.z || 0,
                getLandmarkVisibility(landmark)
            ]);

            const bodyVisible = isWholeBodyVisible(rawLandmarks);
            poseDiagnostics?.displayed(rawLandmarks, displayLandmarks);
            const poseIsValid =
                bodyVisible
                && formValidationReceived
                && latestFormOk;
            const poseColor = poseIsValid
                ? VALID_POSE_COLOR
                : INVALID_POSE_COLOR;
            drawConnectors(
                canvasCtx,
                displayLandmarks,
                POSE_CONNECTIONS,
                { color: poseColor, ...SKELETON_CONNECTOR_STYLE }
            );
            drawSkeletonLandmarks(
                canvasCtx,
                displayLandmarks,
                {
                    color: poseColor,
                    fillColor: poseColor,
                    ...SKELETON_LANDMARK_STYLE
                }
            );
            if (bodyVisible) {
                drawShoulderRaiseHeightGuide(
                    canvasCtx,
                    displayLandmarks
                );
            }
            poseDiagnostics?.drawn(diagnosticTrace);
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
            if (ws && ws.readyState === WebSocket.OPEN) {
                const sendClockMs = performance.now();
                const keypointSendDue =
                    nextKeypointSendAt === null || sendClockMs >= nextKeypointSendAt;
                const websocketReady =
                    ws.bufferedAmount < MAX_WEBSOCKET_BUFFER_BYTES;
                if (keypointSendDue && websocketReady) {
                    const diagnostic = poseDiagnostics?.sent(diagnosticTrace, ws.bufferedAmount);
                    ws.send(JSON.stringify({
                        type: "keypoints",
                        keypoints: keypoints,
                        world_keypoints: worldKeypoints,
                        exercise: exerciseName,
                        timestamp: currentTimestamp / 1000,
                        ...(diagnostic ? { diagnostic } : {})
                    }));
                    nextKeypointSendAt = advanceKeypointDeadline(sendClockMs, nextKeypointSendAt);
                } else {
                    poseDiagnostics?.count(websocketReady ? 'sendCadenceSkips' : 'sendBufferSkips');
                }
                // Soft notify once; server warns without wiping the cycle.
                if (!bodyVisible && exerciseActive && !occlusionSent) {
                    ws.send(JSON.stringify({ type: "occlusion" }));
                    occlusionSent = true;
                } else if (bodyVisible) {
                    occlusionSent = false;
                }
            }
            sendMs = performance.now() - sendStartedAt;

        } else {
            missingFrames++;
            wholeBodyDetected = false;
            latestFormOk = false;
            formValidationReceived = false;
            const uiStartedAt = performance.now();
            updateWholeBodyDetectionUI(false, false);

            if (missingFrames >= MISSING_THRESHOLD && personDetected) {
                personDetected = false;
                resetAndroidPoseSmoothing();
                handleNoPersonDetected();
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "no_person" }));
                }
            }
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
        cameraStream.classList.remove('blur');
        poseCanvas.classList.remove('blur');
        overlayActive = false;
    } else {
        personDetectionOverlay.classList.add('active');
        if (noPersonText) {
            noPersonText.textContent = hasPose
                ? 'Person detected — adjust your position'
                : 'No person detected';
        }
        // Avoid a live-video blur filter competing with pose inference
        // for GPU/compositor time. The red skeleton provides framing.
        cameraStream.classList.remove('blur');
        poseCanvas.classList.remove('blur');
        overlayActive = true;

        if (timerRunning && isPlankExercise) {
            stopTimer();
        }
    }
}

// Handle no person detected
function handleNoPersonDetected() {
    deadliftTrackingStarted = false;
    formStatus.textContent = "NO PERSON";
    formStatus.className = "status bad";
    feedbackText.textContent = "No person detected";

    const mobileFormStatus = document.getElementById('form-status-mobile');
    const mobileFeedbackText = document.getElementById('feedback-text-mobile');

    if (mobileFormStatus) {
        mobileFormStatus.textContent = "NO PERSON";
        mobileFormStatus.className = "bad";
    }

    if (mobileFeedbackText) {
        mobileFeedbackText.textContent = "No person detected";
    }

    if (timerRunning && isPlankExercise) {
        stopTimer();
    }
}

function initializeWebSocket() {
    const apiExercise = exerciseApiNames[exerciseName] || exerciseName;
    const exerciseParam = apiExercise ? `&exercise=${apiExercise}` : '';
    const hammerParams = isMultiModeApiExercise(apiExercise)
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
        repCounter.textContent = formatTime(elapsedTime);
        const mobileRepCounter = document.getElementById('rep-counter-mobile');
        if (mobileRepCounter) {
            mobileRepCounter.textContent = formatTime(elapsedTime);
        }
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
function updateUI(data) {
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
        for (const [id, value] of Object.entries(frontRaiseValues)) {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        }
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
        for (const [id, value] of Object.entries(rdlValues)) {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        }
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
        for (const [id, value] of Object.entries(hammerValues)) {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        }
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
        const isMultiModeExercise =
            ['hammer_curl', 'shoulder front raise', 'shoulder lateral raise']
                .includes(data.exercise)
            || multiModeExerciseKeys.has(exerciseName);
        const showAlternatingArmCounts = isMultiModeExercise && (
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
            repCounter.textContent = displayedRepsText;
        }
        const counterLabel = document.getElementById('counter-label');
        const desiredCounterLabel = showAlternatingArmCounts ? 'LEFT | RIGHT' : 'REPS';
        if (counterLabel && counterLabel.textContent !== desiredCounterLabel) {
            counterLabel.textContent = desiredCounterLabel;
        }

        // Update mobile UI
        const mobileRepCounter = document.getElementById('rep-counter-mobile');
        if (mobileRepCounter && mobileRepCounter.textContent !== displayedRepsText) {
            mobileRepCounter.textContent = displayedRepsText;
            mobileRepCounter.classList.add('pulse');
            setTimeout(() => mobileRepCounter.classList.remove('pulse'), 1000);
        }
        const mobileCounterLabel = document.getElementById('counter-label-mobile');
        if (mobileCounterLabel) {
            mobileCounterLabel.textContent = showAlternatingArmCounts
                ? 'Left | Right:'
                : 'Reps:';
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

                formStatus.textContent = statusText;
                formStatus.className = "status " + (data.form_ok ? "good" : "bad");

                const mobileFormStatus = document.getElementById('form-status-mobile');
                if (mobileFormStatus) {
                    mobileFormStatus.textContent = statusText;
                    mobileFormStatus.className = data.form_ok ? "good" : "bad";
                }
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

                feedbackText.textContent = currentFeedback;

                // Add animation for feedback changes
                feedbackText.style.opacity = '0';
                setTimeout(() => {
                    feedbackText.style.transition = 'opacity 0.5s ease';
                    feedbackText.style.opacity = '1';
                }, 100);

                const mobileFeedbackText = document.getElementById('feedback-text-mobile');
                if (mobileFeedbackText) {
                    mobileFeedbackText.textContent = currentFeedback;

                    // Add animation for feedback changes
                    mobileFeedbackText.style.opacity = '0';
                    setTimeout(() => {
                        mobileFeedbackText.style.transition = 'opacity 0.5s ease';
                        mobileFeedbackText.style.opacity = '1';
                    }, 100);
                }
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
    cameraStream.classList.remove('blur');
    poseCanvas.classList.remove('blur');

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
