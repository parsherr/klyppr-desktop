const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const transcription = require('./modules/transcription');
const audio = require('./modules/audio');
const music = require('./modules/music');

// Use FFmpeg from node_modules in development mode
const isDev = process.env.NODE_ENV === 'development';

// Check FFmpeg binaries and set permissions
async function setupFFmpegBinaries() {
    const isDevelopment = process.env.NODE_ENV === 'development';
    const isWindows = process.platform === 'win32';
    
    let ffmpegPath, ffprobePath;
    
    if (isDevelopment) {
        // Development environment
        if (isWindows) {
            ffmpegPath = path.join(__dirname, 'bin', 'win', 'ffmpeg.exe');
            ffprobePath = path.join(__dirname, 'bin', 'win', 'ffprobe.exe');
        } else {
            ffmpegPath = path.join(__dirname, 'bin', 'mac', 'ffmpeg');
            ffprobePath = path.join(__dirname, 'bin', 'mac', 'ffprobe');
        }
    } else {
        // Production environment
        if (isWindows) {
            ffmpegPath = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
            ffprobePath = path.join(process.resourcesPath, 'bin', 'ffprobe.exe');
        } else {
            ffmpegPath = path.join(process.resourcesPath, 'bin', 'ffmpeg');
            ffprobePath = path.join(process.resourcesPath, 'bin', 'ffprobe');
        }
    }

    console.log('FFmpeg Path:', ffmpegPath);
    console.log('FFprobe Path:', ffprobePath);

    // Check if binaries exist
    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        console.error('FFmpeg binary not found at:', ffmpegPath);
        console.error('FFprobe binary not found at:', ffprobePath);
        throw new Error('FFmpeg or FFprobe binaries not found.');
    }

    // Set FFmpeg paths
    ffmpeg.setFfmpegPath(ffmpegPath);
    ffmpeg.setFfprobePath(ffprobePath);

    return { ffmpegPath, ffprobePath };
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('index.html');
}

// When application starts
app.whenReady().then(async () => {
    try {
        await setupFFmpegBinaries();
        createWindow();
    } catch (error) {
        console.error('Application startup error:', error);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Input file selection
ipcMain.on('select-input', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv'] }
        ]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('input-selected', result.filePaths[0]);
    }
});

// Output folder selection
ipcMain.on('select-output', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
        event.reply('output-selected', result.filePaths[0]);
    }
});

// Video processing
ipcMain.on('start-processing', async (event, params) => {
    await executeProcessingPipeline(event, params);
});

// Get music library
ipcMain.on('get-music-library', async (event) => {
    const musicDir = path.join(__dirname, 'library', 'musics');
    try {
        await fs.ensureDir(musicDir);
        const files = await fs.readdir(musicDir);
        event.reply('music-library-loaded', files);
    } catch (error) {
        event.reply('log', `Error loading music library: ${error.message}`);
    }
});

// Add new music file
ipcMain.on('select-music-file', async (event) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'aac'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
        const sourcePath = result.filePaths[0];
        const musicDir = path.join(__dirname, 'library', 'musics');
        const destPath = path.join(musicDir, path.basename(sourcePath));
        try {
            await fs.copy(sourcePath, destPath);
            // Reload the library for the UI
            const files = await fs.readdir(musicDir);
            event.reply('music-library-loaded', files);
        } catch (error) {
            event.reply('log', `Error adding music file: ${error.message}`);
        }
    }
});

async function executeProcessingPipeline(event, params) {
    let currentPath = params.inputPath;
    const tempDir = path.join(app.getPath('temp'), 'klyppr-processing');
    const finalOutputFile = path.join(params.outputPath, `processed_${path.basename(params.inputPath)}`);

    try {
        await fs.ensureDir(tempDir);
        event.reply('progress', { status: 'Step 1: Initializing...' });

        // Step 1: Transcription (if selected)
        let assPath = null;
        if (params.generateSubtitles) {
            event.reply('progress', { status: 'Step 1/6: Generating subtitles...' });
            assPath = await transcription.generateSubtitles(currentPath, params.apiKey, tempDir);
        }

        // Step 2: Noise Removal (if selected)
        if (params.removeNoise) {
            event.reply('progress', { status: 'Step 2/6: Removing background noise...' });
            const outputPath = path.join(tempDir, `noise-removed_${path.basename(currentPath)}`);
            await audio.cleanNoise(currentPath, outputPath);
            currentPath = outputPath;
        }

        // Step 3: Silence Removal
        event.reply('progress', { status: 'Step 3/6: Removing silences...' });
        const silenceRanges = await detectSilence(currentPath, params, event);
        if (silenceRanges.length > 0) {
            const outputPath = path.join(tempDir, `silence-removed_${path.basename(currentPath)}`);
            await processVideo(currentPath, outputPath, silenceRanges, event);
            currentPath = outputPath;
        } else {
            event.reply('log', 'No silences to remove.');
        }

        // Step 4: Audio Normalization (if selected)
        if (params.normalizeAudio) {
            event.reply('progress', { status: 'Step 4/6: Normalizing audio...' });
            const outputPath = path.join(tempDir, `normalized_${path.basename(currentPath)}`);
            await audio.normalizeLoudness(currentPath, outputPath);
            currentPath = outputPath;
        }

        // Step 5: Add Background Music (if selected)
        if (params.addMusic && params.musicPath) {
            event.reply('progress', { status: 'Step 5/6: Adding background music...' });
            const musicPath = path.join(__dirname, 'library', 'musics', params.musicPath);
            const outputPath = path.join(tempDir, `music-added_${path.basename(currentPath)}`);
            await music.addBackgroundMusic(currentPath, musicPath, params.musicVolume, outputPath);
            currentPath = outputPath;
        }

        // Step 6: Add Subtitles (if assPath exists)
        if (assPath) {
            event.reply('progress', { status: 'Step 6/6: Adding subtitles...' });
            const outputPath = path.join(tempDir, `subtitled_${path.basename(currentPath)}`);
            await transcription.burnSubtitles(currentPath, assPath, outputPath);
            currentPath = outputPath;
        }

        // Final Step: Copy to output directory
        event.reply('progress', { status: 'Finalizing...' });
        await fs.copy(currentPath, finalOutputFile);

        event.reply('completed', true);

    } catch (error) {
        event.reply('log', `Pipeline Error: ${error.message}`);
        event.reply('completed', false);
    } finally {
        // Clean up temp directory
        await fs.remove(tempDir);
        event.reply('log', 'Cleaned up temporary files.');
    }
}

async function detectSilence(inputFile, params, event) {
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;

        event.reply('log', 'Starting silence analysis...');

        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${params.silenceDb}dB:d=${params.minSilenceDuration}`)
            .output('-')
            .on('start', command => {
                event.reply('log', `Running FFmpeg command: ${command}`);
            })
            .on('stderr', line => {
                const silenceStart = line.match(/silence_start: ([\d.]+)/);
                const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                if (silenceStart) {
                    startTime = parseFloat(silenceStart[1]);
                    event.reply('log', `Silence start: ${startTime}s`);
                }
                if (silenceEnd && startTime !== null) {
                    const endTime = parseFloat(silenceEnd[1]);
                    event.reply('log', `Silence end: ${endTime}s`);
                    
                    silenceRanges.push({
                        start: startTime + parseFloat(params.paddingDuration),
                        end: endTime - parseFloat(params.paddingDuration)
                    });
                    startTime = null;
                }
            })
            .on('end', () => {
                event.reply('log', `Found ${silenceRanges.length} silence ranges`);
                resolve(silenceRanges);
            })
            .on('error', reject)
            .run();
    });
}

async function processVideo(inputFile, outputFile, silenceRanges, event) {
    return new Promise((resolve, reject) => {
        // Create a select filter that skips silent parts
        let selectParts = [];
        
        // First part
        if (silenceRanges[0].start > 0) {
            selectParts.push(`between(t,0,${silenceRanges[0].start})`);
        }

        // Parts between silences
        for (let i = 0; i < silenceRanges.length - 1; i++) {
            selectParts.push(
                `between(t,${silenceRanges[i].end},${silenceRanges[i + 1].start})`
            );
        }

        // Last part
        const lastSilence = silenceRanges[silenceRanges.length - 1];
        selectParts.push(`gte(t,${lastSilence.end})`);

        const selectFilter = selectParts.join('+');
        event.reply('log', 'Starting video processing...');

        const isWindows = process.platform === 'win32';
        
        const ffmpegCommand = ffmpeg(inputFile)
            .videoFilters([
                `select='${selectFilter}'`,
                'setpts=N/FRAME_RATE/TB'
            ])
            .audioFilters([
                `aselect='${selectFilter}'`,
                'asetpts=N/SR/TB'
            ]);

        // Platform specific encoding settings
        if (isWindows) {
            ffmpegCommand.outputOptions([
                '-c:v', 'mpeg4',
                '-q:v', '5',
                '-c:a', 'mp3',
                '-b:a', '128k'
            ]);
        } else {
            ffmpegCommand.outputOptions([
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '23',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart'
            ]);
        }

        ffmpegCommand
            .on('start', command => {
                event.reply('log', `Running FFmpeg command: ${command}`);
            })
            .on('progress', progress => {
                const percent = progress.percent ? progress.percent.toFixed(1) : '0';
                event.reply('progress', {
                    status: `Processing: ${percent}%`,
                    percent: parseFloat(percent)
                });
            })
            .on('end', () => {
                event.reply('log', 'Video processing completed');
                resolve();
            })
            .on('error', (err) => {
                event.reply('log', `Error: ${err.message}`);
                reject(err);
            })
            .save(outputFile);
    });
} 