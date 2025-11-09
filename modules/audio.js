const ffmpeg = require('fluent-ffmpeg');

async function cleanNoise(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .audioFilters('afftdn')
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

async function normalizeLoudness(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .audioFilters('loudnorm=I=-13:LRA=1')
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

module.exports = {
    cleanNoise,
    normalizeLoudness,
};
