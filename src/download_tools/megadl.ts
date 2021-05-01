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

// fileStats = { 0: { name: string, size: number, transferred:number, speed:number , isDownload: boolean } }
let fileStats:any = {};

// mainObject = { name:string, dlDir:string, realFilePath: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, size:number, transferred:number, files:number, filesdownloaded:number }
let mainObject:any = {};

let progressBar: NodeJS.Timeout = null;

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
        console.error(error.message);
        finalMessage = `Failed to start download <code>${url}</code>. ${error.message}`;

        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    if (!item.key) {
        console.error("ERROR: downloading without an encryption key isn't supported");
        finalMessage = `ERROR: downloading without an encryption key isn't supported`;

        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    item.loadAttributes( (err: any, object: any ) => {
        if (err) {
            console.error(`Failed to download - ${url}: ${err.message}`);

            let finalMessage = `Failed to download <code>${url}</code>. ${err.message}`;
            msgTools.deleteMsg(bot, tgMsg);
            msgTools.sendMessage(bot, actualMsg, finalMessage, 10000);
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
                } else {
                    console.log('Download Done!')
                    console.log( mainObject.transferred,'/',mainObject.size, mainObject.filesDownloaded,'/', mainObject.totalFiles )
                }
                console.log( mainObject.transferred,'/',mainObject.size, mainObject.filesDownloaded,'/', mainObject.totalFiles )
            }, constants.STATUS_UPDATE_INTERVAL_MS ? constants.STATUS_UPDATE_INTERVAL_MS : 12000);

            downloadFiles(object, dlDirPath);
        }
        
        console.log('Download started for all files...');
        

    });
}


function downloadFiles(object: any, path: string) {
    if (object.directory) {

        mainObject.totalDirs += 1;

        path += object.name + '/';
        fs.mkdirSync(path, { recursive: true });

        if (object.children) {
            object.children.forEach( (file:any) => {
                downloadFiles(file, path);
            });
        }
    } else {

        let downloadStream = object.download( { forceHttps: true } )
                .on('error', (err:Error) => {
                    console.error(err);
                    if (err.message != "You can't download past the end of the file.") {
                        msgTools.sendMessage(mainObject.bot, mainObject.actualMsg, 'Error: ' + err.message);
                    }
                  });

        //targetStat.file[mainObject.totalFiles]={ name: object.name, parent: mainObject.dirCount, size: object.size, isDownloaded: false };
        fileStats[mainObject.totalFiles]= { name: object.name, size:object.size, transferred:0, isDownloaded: false };
        mainObject.size += object.size;

        const progressStream = createFileProgressStream(object.name, object.size, mainObject.totalFiles);
        downloadStream = downloadStream.pipe(progressStream);
        mainObject.totalFiles += 1;

        downloadStream.on('end', () => {
            if (mainObject.transferred == mainObject.size || mainObject.totalFiles == mainObject.filesDownloaded ) {
                preUpload();
            } else { console.log('filesDownloaded ', mainObject.filesDownloaded+'/'+mainObject.totalFiles); }
        }).pipe(fs.createWriteStream(path + object.name));

    }
}

function createFileProgressStream (filename: string, length: number, index: number) {

    const stream = progressStream({
        length,
        time: 1000
    });

    stream.on('progress', (progress: any) => {
        mainObject.transferred += progress.transferred - fileStats[index]['transferred'];
        dlDetails.uploadedBytes += progress.transferred - fileStats[index]['transferred'];
        fileStats[index]['transferred']=progress.transferred;
        fileStats[index]['speed']=progress.speed;
    });

    stream.on('finish', async () => {
        console.log('Download completed for',filename,index+1);
        mainObject.filesDownloaded += 1;
        fileStats[index]['isDownloaded'] = true;
        //await startUpload(dlDir, realFilePath, filename, bot, tgMsg, actualMsg, `Downloading: <code>${filename}</code>`);
    });

    return stream;
}

function fileSize (bytes: number) {
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  const result = (bytes / Math.pow(1024, exp)).toFixed(2);

  return result + ' ' + (exp === 0 ? 'bytes' : 'KMGTPEZY'.charAt(exp - 1) + 'B');
}


function isDownloadComplete(file: string, targetSize: number) {
    const { size } = fs.statSync(file);
    if (size !== targetSize) return false;
    return true;
}

/*
function defaultDownloadCallback (error: any) {
  if (error) {
    console.error(error)
    msgTools.deleteMsg(mainObject.bot, mainObject.tgMsg);
    msgTools.sendMessage(mainObject.bot, mainObject.actualMsg, `Error: ${error.message}`);
  }
}
*/

async function preUpload() {

    msgTools.editMessage( mainObject.bot, mainObject.tgMsg, `<b>Downloading:</b> <code>${mainObject.name}</code>`);

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
    message += `\n✔Download complete, starting upload...`;
    msgTools.editMessage(bot, tgMsg, message);

    console.log('File size-->', size);

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

export function getMetadata( url: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message ) {

    url = url.trim();
    let finalMessage;
    let item:any;
    let stats:any;
    let folderCount = 0;
    let fileCount = 0;
    let structure = ''

    try {
        item = File.fromURL(url);
    } catch (error) {
        console.error(error.message);
        finalMessage = `Failed to load <code>${url}</code>. ${error.message}`;

        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    if (!item.key) {
        console.error("ERROR: url without an encryption key isn't supported");
        finalMessage = `ERROR: url without an encryption key isn't supported`;

        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    item.loadAttributes( (err: any, object: any ) => {
        if (err) {
            console.error(`Failed to get metadata - ${url}: ${err.message}`);

            let finalMessage = `Failed to get metadata for <code>${url}</code>. ${err.message}`;
            msgTools.deleteMsg(bot, tgMsg);
            msgTools.sendMessage(bot, actualMsg, finalMessage, 10000);
            return;
        } else {
            forFolder(object, object.name)
        }
    });

    function forFolder(object: any, path:string) {
        if (object.directory) {
            path += '/';
            stats.folder[folderCount] = { name: object.name, realPath:path };
            if ( object.children != undefined ) {
                stats.folder[folderCount] = { files:object.children.length }
                object.children.forEach( (file:any) => {
                    forFolder(file, path + object.name );
                });
            }
            folderCount += 1;
        } else {
            stats.file[fileCount] = { name:object.name, size:object.size, realPath:path };
            fileCount += 1;
        }
    }
}

/*  mf=`├`   fe=`│`   ef=`└`    ff=`—`.repeat(folderCount + 1) — — — — — ——
            Sti
Main Folder\n
│
├——folder1
│  │
│  └--folder2
├     
│
├
│
└




*/
// gid generator - randomString(16)
function randomString(len:number) {
    var str = "";
    for (var i=0; i < len; i++) {
        var r = Math.random() * 62 << 0;
        str += String.fromCharCode(r += r > 9 ? r < 36 ? 55 : 61 : 48).toLowerCase();
    }
    return str;
}