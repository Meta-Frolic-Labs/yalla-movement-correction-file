(function exposeExerciseRegistry(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.exerciseRegistry = api;
}(typeof globalThis !== 'undefined' ? globalThis : window, function buildExerciseRegistry() {
    const exercises = Object.freeze([
        {
            key: 'barbell_biceps_curl_rules',
            apiName: 'barbell biceps curl',
            label: 'Barbell Biceps Curl',
            iconPath: './images/exercises/barbel-curls.png'
        },
        {
            key: 'hammer_curl_rules',
            apiName: 'hammer_curl',
            label: 'Hammer Curl',
            iconPath: './images/exercises/hammercurl.png',
            multiMode: true
        },
        {
            key: 'shoulder_front_raise_rules',
            apiName: 'shoulder front raise',
            label: 'Shoulder Front Raises',
            iconPath: './images/exercises/shoulderfrontraises.png',
            multiMode: true
        },
        {
            key: 'shoulder_lateral_raise_rules',
            apiName: 'shoulder lateral raise',
            label: 'Shoulder Lateral Raises',
            iconPath: './images/exercises/literal_raises.png',
            multiMode: true
        },
        {
            key: 'squat_rules',
            apiName: 'squat',
            label: 'Squat',
            iconPath: './images/exercises/squat.png'
        },
        {
            key: 'pushup_rules',
            apiName: 'push-up',
            label: 'Push-Up',
            iconPath: './images/exercises/pushups.png'
        },
        {
            key: 'plank_rules',
            apiName: 'plank',
            label: 'Plank',
            iconPath: './images/exercises/plank.png'
        },
        {
            key: 'deadlift_rules',
            apiName: 'deadlift',
            label: 'Deadlift',
            iconPath: './images/exercises/deadlift.png?v=2'
        },
        {
            key: 'romanian_deadlift_rules',
            apiName: 'romanian_deadlift',
            label: 'Romanian Deadlift',
            iconPath: './images/exercises/deadlift.png?v=2'
        },
        {
            key: 'leg_raise_rules',
            apiName: 'leg_raise',
            label: 'Lying Leg Raises',
            iconPath: './images/exercises/leg-raises.png'
        }
    ].map((exercise) => Object.freeze({ multiMode: false, ...exercise })));

    const byKey = new Map(exercises.map((exercise) => [exercise.key, exercise]));
    const byApiName = new Map(
        exercises.map((exercise) => [exercise.apiName, exercise])
    );

    function resolveExercise(identifier) {
        return byKey.get(identifier) || byApiName.get(identifier) || null;
    }

    function isMultiModeExercise(identifier) {
        return resolveExercise(identifier)?.multiMode === true;
    }

    return Object.freeze({ exercises, resolveExercise, isMultiModeExercise });
}));
