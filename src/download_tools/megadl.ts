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

const dlDetails: DlVars = {
    isTar: false,
    isUnzip: false,
    tgUsername: '',
    gid: randomString(16),
    downloadDir: '',
    tgChatId: 0,
    tgFromId: 0,
    tgMessageId: 0,
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

// fileStats = { 0: { name: string, size: number, transferred:number, speed:number , isDownload: boolean } }
let fileStats:any = {};

// mainObject = { name:string, dlDir:string, realFilePath: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, size:number, transferred:number, files:number, filesdownloaded:number }
let mainObject:any = { name:'', dlDir:'', realFilePath: '', size:0, speed:0, transferred:0, totalFiles:0, totalDirs:0, filesDownloaded:0, lastStatusMsg:'' };
let dlStats:any = {};

let progressInterval:any

export async function megaWrapper(url: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message) {
    url = url.trim();
    let finalMessage;
    let item:any;

    try {
        item = File.fromURL(url);
    } catch (error) {
        console.error(error.message);
        //process.exit(1);
        finalMessage = `Failed to start download <code>${url}</code>. ${error.message}`;

        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    if (!item.key) {
        console.error("ERROR: downloading without an encryption key isn't supported");
        //process.exit(1);
        finalMessage = `ERROR: downloading without an encryption key isn't supported`;

        msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    item.loadAttributes((err: any, object: any ) => {
        if (err) {
            console.error(`Failed to download - ${url}: ${err.message}`);
            //process.exit(1);

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
            mainObject.name = object['name'];
            mainObject.dlDir = uuidv4();
            mainObject.realFilePath = `${constants.ARIA_DOWNLOAD_LOCATION}/${mainObject.dlDir}/${mainObject.name}`;
            let dlDirPath = constants.ARIA_DOWNLOAD_LOCATION + '/' + mainObject.dlDir + '/';
            fs.mkdirSync(dlDirPath, { recursive: true });
            downloadFiles(object, dlDirPath);
        }
    });

    console.log('Download started for all files...');

    let message = `<b>Downloading:</b> <code>${mainObject.name}</code>`;
    driveTar.updateStatus(dlDetails, mainObject.size, message, bot, tgMsg);

    let progressInterval = setInterval(() => {
        driveTar.updateStatus(dlDetails, mainObject.size, message, bot, tgMsg);
    }, constants.STATUS_UPDATE_INTERVAL_MS ? constants.STATUS_UPDATE_INTERVAL_MS : 12000);
    let wait = setTimeout(preUpload(), 50000)

    /*
        status = downloadUtils.generateStatusMessage2(mainObject.size, mainObject.transferred, speed);

        //console.log( mainObject.size, mainObject.transferred)
        if ( mainObject.totalFiles === mainObject.filesDownloaded || mainObject.transferred === mainObject.size ) {
            console.log('3')
            clearInterval(progressInterval);
            preUpload()
        }

        if (mainObject.lastStatusMsg !== msg) {
            mainObject.lastStatusMsg = msg;
            msgTools.editMessage(bot, tgMsg, msg)catch(e => {
            console.error('UpdateStatus error: ', e.message);
        });;
        }
    }, constants.STATUS_UPDATE_INTERVAL_MS ? constants.STATUS_UPDATE_INTERVAL_MS : 12000 );
    */

}

function downloadFiles(object: any, path: string) {
    if (object.directory) {

        mainObject.totalDirs += 1;

        path += object.name + '/';
        fs.mkdirSync(path, { recursive: true });

        console.log('Dir:', object.name, '| Contains', object.children.length ,'files/folders');

        object.children.forEach( (file:any) => {
            downloadFiles(file, path);
        })
    } else {

        let downloadStream = object.download();

        //targetStat.file[mainObject.totalFiles]={ name: object.name, parent: mainObject.dirCount, size: object.size, isDownloaded: false };
        fileStats[mainObject.totalFiles]= { name: object.name, size:object.size, transferred:0, isDownloaded: false }
        mainObject.size += object.size

        const progressStream = createFileProgressStream(object.name, object.size, mainObject.totalFiles);
        downloadStream = downloadStream.pipe(progressStream);

        downloadStream.on('end', (err:any) => {
           console.error(err)
        }).pipe(fs.createWriteStream(path + object.name));

        mainObject.totalFiles += 1
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
function defaultDownloadCallback (error: any, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message) {
  if (error) {
    console.error(error)
    msgTools.deleteMsg(bot, tgMsg);
    msgTools.sendMessage(bot, actualMsg, `Error: ${error.message}`);
    //process.exit(1)
  }
}
*/

async function preUpload() {
    console.log('1')
    while (mainObject.transferred != mainObject.size || mainObject.totalFiles != mainObject.filesDownloaded ) { }

        dlDetails.isUploading = true
        console.log('2')
        console.log('Download Complete.')
        await startUpload( mainObject.dlDir, mainObject.size, mainObject.realFilePath, mainObject.name, mainObject.bot, mainObject.tgMsg, mainObject.actualMsg, `<b>Downloading:</b> <code>${mainObject.name}</code>`);

}

async function startUpload(dlDir: string, size: number, file: string, filename: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, message: string) {
    clearInterval(progressInterval);

    message += `\n\n✔Download complete, starting upload...`;
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
            if (size) {
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

// gid generator - randomString(16)
function randomString(len:number) {
    var str = "";
    for (var i=0; i < len; i++) {
        var r = Math.random() * 62 << 0;
        str += String.fromCharCode(r += r > 9 ? r < 36 ? 55 : 61 : 48).toLowerCase();
    }
    return str;
}