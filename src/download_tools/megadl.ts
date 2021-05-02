import constants = require('../.constants');
import TelegramBot = require('node-telegram-bot-api');
import msgTools = require('../bot_utils/msg-tools');
import { v4 as uuidv4 } from 'uuid';
import driveTar = require('../drive/drive-tar');
import { DlVars } from '../dl_model/detail';
import fs from 'fs';
import downloadUtils = require('../download_tools/utils');
import { File } from 'megajs';
const progressStream = require('progress-stream');

let dlDetails:DlVars;

// activeDl ={ gid : { progressBar:null, dlDetails } }
let activeDl: any = {}

// fileStats = { 0: { name: string, size: number, transferred:number, speed:number , isDownload: boolean } }
let fileStats:any = {};

// mainObject = { name:string, dlDir:string, realFilePath: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, size:number, transferred:number, files:number, filesdownloaded:number }
let mainObject:any = {};

let progressBar: NodeJS.Timeout = null;



// gid generator - randomString(16)
function randomString(len:number) {
    var str = "";
    for (var i=0; i < len; i++) {
        var r = Math.random() * 62 << 0;
        str += String.fromCharCode(r += r > 9 ? r < 36 ? 55 : 61 : 48).toLowerCase();
    }
    return str;
}


export async function megaWrapper(url: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message) {

    dlDetails = {
        isTar: false,
        isUnzip: false,
        tgUsername: '',
        gid: randomString(16),
        downloadDir: '',
        tgChatId: 0,
        tgFromId: 0,
        tgMessageId: 0,
        isDuplicateMirror: 0,
        tgRepliedUsername: '',
        isDownloadAllowed: 1,
        isDownloading: true,
        isUploading: false,
        uploadedBytes: 0,
        uploadedBytesLast: 0,
        startTime: new Date().getTime(),
        lastUploadCheckTimestamp: 0,
        isExtracting: false,
        extractedFileName: '',
        extractedFileSize: ''
    };

    fileStats = {};
    mainObject = { name:'', dlDir:'', realFilePath: '', size:0, speed:0, transferred:0, totalFiles:0, totalDirs:0, filesDownloaded:0, lastStatusMsg:'' };


    url = url.trim();
    let finalMessage;
    let item:any;

    try {
        item = File.fromURL(url);
    } catch (error) {
        defaultErrorCallback( error, `Failed to start download - <code>${url}</code>: ${error.message}`);
        return;
    }

    if (!item.key) {
        defaultErrorCallback(null, "ERROR: downloading without an encryption key isn't supported");
        return;
    }

    item.loadAttributes( (err: any, object: any ) => {
        if (err) {
            defaultErrorCallback( err, `Failed to download - <code>${url}</code>: ${err.message}`);
            return;
        } else {
            let message = `<b>Downloading:</b> <code>${object.name}</code>`;
            msgTools.editMessage(bot, tgMsg, message);

            mainObject.bot = bot;
            mainObject.tgMsg = tgMsg;
            mainObject.actualMsg = actualMsg;
            mainObject.name = object.name;
            mainObject.dlDir = uuidv4();
            mainObject.realFilePath = `${constants.ARIA_DOWNLOAD_LOCATION}/${mainObject.dlDir}/${mainObject.name}`;

            let dlDirPath = constants.ARIA_DOWNLOAD_LOCATION + '/' + mainObject.dlDir + '/';
            fs.mkdirSync(dlDirPath, { recursive: true });

            progressBar = setInterval( () => {
                if (!( mainObject.transferred == mainObject.size || mainObject.totalFiles == mainObject.filesDownloaded )) {
                    driveTar.updateStatus(dlDetails, mainObject.size, message, mainObject.bot, mainObject.tgMsg);   
                }
            }, constants.STATUS_UPDATE_INTERVAL_MS ? constants.STATUS_UPDATE_INTERVAL_MS : 12000);

            downloadFolderLoop(object, dlDirPath);
        }
        
        console.log('Download started for all files...');
        

    });
}


function defaultErrorCallback(error: Error, msg='') { 
    if (error) {

        if ( msg == '' ) {
            msg = error.message
        }
        console.error(msg)

        msgTools.deleteMsg(mainObject.bot, mainObject.tgMsg);
        msgTools.sendMessage(mainObject.bot, mainObject.actualMsg, msg);
        clearInterval(progressBar);
        downloadUtils.deleteDownloadedFile(mainObject.dlDir);
    }
}


function downloadFolderLoop(object: any, path: string) {
    if (object.directory) {

        mainObject.totalDirs += 1;

        path += object.name + '/';
        fs.mkdirSync(path, { recursive: true });

        if (object.children) {
            object.children.forEach( (item:any) => {
                downloadFolderLoop(item, path);
            });
        }
    } else {

        fileStats[object.name]= { name: object.name, dlPath:path, size:object.size, transferred:0, isDownloaded: false };
        mainObject.size += object.size;
        mainObject.totalFiles += 1;

        downloadFile(object, path)
    }
}


function downloadFile( file:any, path:string, startByte = 0) {
    let downloadStream = file
        .download( {
            start: startByte,
            forceHttps: true 
        })
        .on('error', (err:Error) => {

            // Error for files with 0 size
            if (err.message != "You can't download past the end of the file.") {

                // MAC verification failed, re-continue download
                if (err.message == "MAC verification failed") {
                    const { size } = fs.statSync( path + file.name );
                    if (size < file.size) {
                        downloadFile( file, fileStats[file.name].dlPath, size)
                    } else {
                        mainObject.filesDownloaded += 1;
                        fileStats[file.name]['isDownloaded'] = true;
                    }

                // Connection issue, don't do anything as the download is still going on
                } else if ( err.message.search('socket hang up') > -1 ) {
                    console.error(err.message)

                } else {
                    msgTools.sendMessage(mainObject.bot, mainObject.actualMsg, 'Error: ' + err.message);
                    defaultErrorCallback(err);
                }
            }
        });

    const progress = createFileProgressStream(file.name, file.size, startByte);
    downloadStream = downloadStream.pipe(progress);

    downloadStream.on('end', () => {
        if (mainObject.transferred == mainObject.size || mainObject.totalFiles == mainObject.filesDownloaded) {
            preUpload();
        }
    }).pipe(fs.createWriteStream(path + file.name));

}


function createFileProgressStream (filename: string, length: number, startByte: number) {

    const stream = progressStream({
        length,
        transferred: startByte,
        time: 1000
    });

    stream.on('progress', (progress: any) => {
        mainObject.transferred += progress.transferred - fileStats[filename]['transferred'];
        dlDetails.uploadedBytes += progress.transferred - fileStats[filename]['transferred'];
        fileStats[filename]['transferred']=progress.transferred;
        fileStats[filename]['speed']=progress.speed;
    });

    stream.on('finish', async () => {
        mainObject.filesDownloaded += 1;
        fileStats[filename]['isDownloaded'] = true;
        //await startUpload(dlDir, realFilePath, filename, bot, tgMsg, actualMsg, `Downloading: <code>${filename}</code>`);
    });

    return stream;
}


function fileSize (bytes: number) {
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  const result = (bytes / Math.pow(1024, exp)).toFixed(2);

  return result + ' ' + (exp === 0 ? 'bytes' : 'KMGTPEZY'.charAt(exp - 1) + 'B');
}


async function preUpload() {

    //msgTools.editMessage( mainObject.bot, mainObject.tgMsg, `<b>Downloading:</b> <code>${mainObject.name}</code>`);
    driveTar.updateStatus(dlDetails, mainObject.size, `<b>Downloading:</b> <code>${mainObject.name}</code>`, mainObject.bot, mainObject.tgMsg);

    dlDetails.isDownloading = false;
    dlDetails.isUploading = true;
    dlDetails.uploadedBytes = 0;
    dlDetails.uploadedBytesLast = 0;
    dlDetails.lastUploadCheckTimestamp = 0;

    console.log('Download Complete.');
    await startUpload( mainObject.dlDir, mainObject.size, mainObject.realFilePath, mainObject.name, mainObject.bot, mainObject.tgMsg, mainObject.actualMsg, `<b>Downloading:</b> <code>${mainObject.name}</code>`);

    // Cleanup
    fileStats = {};
    mainObject = { name:'', dlDir:'', realFilePath: '', size:0, speed:0, transferred:0, totalFiles:0, totalDirs:0, filesDownloaded:0, lastStatusMsg:'' };
    clearInterval(progressBar);
    
    return;
}



async function startUpload(dlDir: string, size: number, file: string, filename: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, message: string) {
    message += `\n✔✔Download complete, starting upload...`;
    msgTools.editMessage(bot, tgMsg, message);

    driveTar.updateStatus(dlDetails, size, message, bot, tgMsg);
    let statusInterval = setInterval(() => {
        driveTar.updateStatus(dlDetails, size, message, bot, tgMsg);
    }, constants.STATUS_UPDATE_INTERVAL_MS ? constants.STATUS_UPDATE_INTERVAL_MS : 12000);

    driveTar.driveUploadFile(file, dlDetails, (uperr, url, isFolder, indexLink) => {
        clearInterval(statusInterval);
        var finalMessage;
        if (uperr) {
            console.error(`Failed to upload - ${filename}: ${uperr}`);
            finalMessage = `Failed to upload <code>${filename}</code> to Drive. ${uperr}`;
            msgTools.deleteMsg(bot, tgMsg);
            msgTools.sendMessage(bot, actualMsg, finalMessage, 10000);
        } else {
            console.log(`Uploaded ${filename}`);
            if (size) {;
                var fileSizeStr = downloadUtils.formatSize(size);
                finalMessage = `<b>GDrive Link</b>: <a href="${url}">${filename}</a> (${fileSizeStr})`;
                if (indexLink && constants.INDEX_DOMAIN) {
                    finalMessage += `\n\n<b>Do not share the GDrive Link. \n\nYou can share this link</b>: <a href="${indexLink}">${filename}</a>`;
                }
            } else {
                finalMessage = `<a href='${url}'>${filename}</a>`;
            }
        }
        downloadUtils.deleteDownloadedFile(dlDir);
        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage, -1);
    });
}