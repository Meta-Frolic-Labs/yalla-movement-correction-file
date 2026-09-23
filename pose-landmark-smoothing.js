(function exposePoseLandmarkSmoothing(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.createPoseLandmarkSmoother = api.createPoseLandmarkSmoother;
}(typeof globalThis !== 'undefined' ? globalThis : window, function buildPoseLandmarkSmoothing() {
    const HISTORY_SIZE = 3;
    const ALPHA = 0.5;
    const MIN_CONFIDENCE = 0.5;

    function median(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : 0.5 * (sorted[middle - 1] + sorted[middle]);
    }

    function confidence(landmark) {
        const visibility = Number(landmark.visibility);
        const presence = Number(landmark.presence);
        if (Number.isFinite(visibility) && Number.isFinite(presence)) {
            return Math.min(visibility, presence);
        }
        if (Number.isFinite(visibility)) return visibility;
        if (Number.isFinite(presence)) return presence;
        return 1;
    }

    function createPoseLandmarkSmoother() {
        let histories = [];
        let previous = [];

        function reset() {
            histories = [];
            previous = [];
        }

        function update(landmarks) {
            if (!landmarks?.length) return landmarks;
            const nextHistories = [];
            const filtered = landmarks.map((landmark, index) => {
                const prior = previous[index];
                const history = histories[index] ? [...histories[index]] : [];
                const result = { ...landmark };
                const valid = confidence(landmark) >= MIN_CONFIDENCE
                    && ['x', 'y', 'z'].every((axis) => Number.isFinite(landmark[axis]));

                if (valid) {
                    history.push([landmark.x, landmark.y, landmark.z]);
                    if (history.length > HISTORY_SIZE) history.shift();
                    for (const [axisIndex, axis] of ['x', 'y', 'z'].entries()) {
                        const target = median(history.map((sample) => sample[axisIndex]));
                        result[axis] = prior
                            ? prior[axis] + ALPHA * (target - prior[axis])
                            : target;
                    }
                } else if (prior) {
                    for (const axis of ['x', 'y', 'z']) {
                        result[axis] = prior[axis];
                    }
                }

                nextHistories[index] = history;
                return result;
            });
            histories = nextHistories;
            previous = filtered;
            return filtered;
        }

        return Object.freeze({ update, reset });
    }

    return { createPoseLandmarkSmoother };
}));
