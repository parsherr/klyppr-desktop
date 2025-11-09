const ffmpeg = require('fluent-ffmpeg');

async function addBackgroundMusic(videoPath, musicPath, volume, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .input(musicPath)
            .complexFilter([
                `[0:a]volume=1[a];[1:a]volume=${volume}dB[b];[a][b]amix=inputs=2:duration=first[aout]`
            ], 'aout')
            .outputOptions('-map', '0:v', '-map', '[aout]', '-c:v', 'copy')
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

module.exports = {
    addBackgroundMusic,
};
