const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const whisper = require('whisper-node');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// Helper to format time from seconds to SRT format (HH:MM:SS,ms)
function formatTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    const timeStr = date.toISOString().substr(11, 12);
    return timeStr.replace('.', ',');
}

// Convert SpeechFlow's JSON response to SRT format
function toSrtSpeechFlow(data) {
    let srt = '';
    data.result.forEach((segment, index) => {
        const start = formatTime(segment.start_time);
        const end = formatTime(segment.end_time);
        srt += `${index + 1}\n`;
        srt += `${start} --> ${end}\n`;
        srt += `${segment.text.trim()}\n\n`;
    });
    return srt;
}

// Convert whisper-node's output to SRT format
function toSrtWhisper(data) {
    let srt = '';
    data.forEach((segment, index) => {
        const start = segment.start;
        const end = segment.end;
        srt += `${index + 1}\n`;
        srt += `${start} --> ${end}\n`;
        srt += `${segment.speech.trim()}\n\n`;
    });
    return srt;
}

// Main function to generate the SRT file
async function generateSrt(videoPath, apiKey, tempDir) {
    const tempAudioPath = path.join(tempDir, 'temp_audio.wav');
    const srtOutputPath = path.join(tempDir, `${path.basename(videoPath)}.srt`);

    try {
        // 1. Extract audio from video in WAV format for whisper
        await new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .noVideo()
                .audioCodec('pcm_s16le')
                .audioFrequency(16000)
                .audioChannels(1)
                .output(tempAudioPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
        });

        let srtContent;

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
            while (true) {
                const statusResponse = await axios.get(`https://api.speechflow.io/v1/file/result?taskId=${taskId}`, {
                    headers: { 'key': apiKey },
                });

                if (statusResponse.data.code === 11000) {
                    transcript = statusResponse.data;
                    break;
                } else if (statusResponse.data.code !== 11001) {
                    throw new Error(`SpeechFlow API error: ${statusResponse.data.msg}`);
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            srtContent = toSrtSpeechFlow(transcript);

        } else {
            // Use local whisper-node
            try {
                await exec('ffmpeg -version');
            } catch (error) {
                throw new Error('FFmpeg is not installed. It is required for local transcription.');
            }

            const transcript = await whisper(tempAudioPath, {
                modelName: "base",
                language: "tr",
                genSrt: true
            });

            // The library seems to have a bug where it returns an array of objects, not the SRT file path.
            // So we manually construct the SRT.
             srtContent = fs.readFileSync(`${tempAudioPath}.srt`, 'utf-8');

        }

        await fs.writeFile(srtOutputPath, srtContent);
        return srtOutputPath;

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
async function burnSubtitles(videoPath, srtPath, outputPath) {
    return new Promise((resolve, reject) => {
        const subtitlesPath = process.platform === 'win32'
            ? srtPath.replace(/\\/g, '/').replace('C:', '\\\\C\\\\:')
            : srtPath;

        ffmpeg(videoPath)
            .videoFilters(`subtitles=${subtitlesPath}:force_style='FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,BorderStyle=3,Outline=1,Shadow=1'`)
            .output(outputPath)
            .on('end', resolve)
            .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
            .run();
    });
}

module.exports = {
    generateSrt,
    burnSubtitles,
};
