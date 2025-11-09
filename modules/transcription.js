const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const whisper = require('whisper-node');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// Helper to format time for ASS format (H:MM:SS.ss)
function formatAssTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    const timeStr = date.toISOString().substr(12, 10);
    return `0:${timeStr}`;
}

// Convert transcription data to ASS format with animation
function toAss(data, format) {
    const header = `[Script Info]
Title: Animated Subtitles
ScriptType: v4.00+
WrapStyle: 0
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,55,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,15,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    let events = '';
    const segments = format === 'speechflow' ? data.result : data;

    segments.forEach(segment => {
        const start = formatAssTime(format === 'speechflow' ? segment.start_time : segment.start);
        const end = formatAssTime(format === 'speechflow' ? segment.end_time : segment.end);
        const text = (format === 'speechflow' ? segment.text : segment.speech).trim();
        // Simple fade effect
        events += `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(200,200)}${text}\n`;
    });

    return header + events;
}


// Main function to generate the subtitle file
async function generateSubtitles(videoPath, apiKey, tempDir) {
    const tempAudioPath = path.join(tempDir, 'temp_audio.wav');
    const assOutputPath = path.join(tempDir, `${path.basename(videoPath)}.ass`);

    try {
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .noVideo()
                .audioCodec('pcm_s16le').audioFrequency(16000).audioChannels(1)
                .output(tempAudioPath)
                .on('end', resolve).on('error', reject)
                .run();
        });

        let assContent;

        if (apiKey) {
            // Use SpeechFlow API
            const formData = new FormData();
            formData.append('file', fs.createReadStream(tempAudioPath));
            formData.append('lang', 'tr');
            const uploadResponse = await axios.post('https://api.speechflow.io/v1/file/upload', formData, {
                headers: { ...formData.getHeaders(), 'key': apiKey },
            });
            const taskId = uploadResponse.data.taskId;

            let transcript;
            let retries = 0;
            const maxRetries = 60;

            while (retries < maxRetries) {
                const statusResponse = await axios.get(`https://api.speechflow.io/v1/file/result?taskId=${taskId}`, {
                    headers: { 'key': apiKey },
                });
                if (statusResponse.data.code === 11000) {
                    transcript = statusResponse.data;
                    break;
                } else if (statusResponse.data.code !== 11001) {
                    throw new Error(`SpeechFlow API error: ${statusResponse.data.msg}`);
                }
                retries++;
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            if (!transcript) {
                throw new Error('Transcription timed out.');
            }
            assContent = toAss(transcript, 'speechflow');

        } else {
            // Use local whisper-node
            const transcript = await whisper(tempAudioPath, {
                modelName: "base",
                language: "tr"
            });
            assContent = toAss(transcript, 'whisper');
        }

        await fs.writeFile(assOutputPath, assContent);
        return assOutputPath;

    } catch (error) {
        console.error('Error during transcription:', error);
        throw new Error(`Failed to generate subtitles: ${error.message}`);
    } finally {
        if (await fs.exists(tempAudioPath)) {
            await fs.remove(tempAudioPath);
        }
    }
}

// Function to burn subtitles onto the video
async function burnSubtitles(videoPath, assPath, outputPath) {
    return new Promise((resolve, reject) => {
        const subtitlesPath = process.platform === 'win32'
            ? assPath.replace(/\\/g, '/').replace('C:', '\\\\C\\\\:')
            : assPath;

        ffmpeg(videoPath)
            .videoFilters(`ass=${subtitlesPath}`)
            .output(outputPath)
            .on('end', resolve)
            .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
            .run();
    });
}

module.exports = {
    generateSubtitles,
    burnSubtitles,
};
