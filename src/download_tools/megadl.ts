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
    gid: '',
    downloadDir: '',
    tgChatId: 0,
    tgFromId: 0,
    tgMessageId: 0,
    tgRepliedUsername: '',
    isDownloadAllowed: 1,
    isDownloading: true,
    isUploading: true,
    uploadedBytes: 0,
    uploadedBytesLast: 0,
    startTime: 0,
    lastUploadCheckTimestamp: 0,
    isExtracting: false,
    extractedFileName: '',
    extractedFileSize: ''
};

// dir:  { 0: { fileName: string, path: string, parent: int (targetStat.dir.[parent]) }}
// file: { 0: { fileName: string, path: string, parent: int (targetStat.dir.[parent]), size: int (bytes), isDownloaded: boolean, isUploaded: boolean }}
let targetStat:any = {
    dir: { },
    file: { }
};

let dirCount:any;
let fileCount=0;

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

        //msgTools.deleteMsg(bot, tgMsg);
        msgTools.sendMessage(bot, actualMsg, finalMessage);
        return;
    }

    if (!item.key) {
        console.error("ERROR: downloading without an encryption key isn't supported");
        //process.exit(1);
        finalMessage = `ERROR: downloading without an encryption key isn't supported`;

        //msgTools.deleteMsg(bot, tgMsg);
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

        let message = `Downloading: <code>${object.name}</code>`;
        msgTools.editMessage(bot, tgMsg, message);

        let dlDir = uuidv4();
        let dlDirPath = constants.ARIA_DOWNLOAD_LOCATION + '/' + dlDir + '/';
        let realFilePath = `${constants.ARIA_DOWNLOAD_LOCATION}/${dlDir}/${object.name}`;
        fs.mkdirSync(dlDirPath, { recursive: true });

        let showProgress = object.directory === false ? true : false;
        downloadFiles(object, dlDir, dlDirPath, realFilePath, bot, tgMsg, actualMsg, showProgress);

        }
    });
}

function downloadFiles(object: any, dlDir: string, path: string, realFilePath: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, showProgress=false) {
    if (object.directory) {
        showProgress=false;
        targetStat.dir[dirCount]={ name: object.name, path: path + object.name, parent: dirCount };
        dirCount = dirCount === 'undefined' ? 0 : dirCount + 1;
        //console.log(object.size);
        path += object.name + '/';
        fs.mkdirSync(path, { recursive: true });
        console.log('Dir:', object.name, '| Contains', object.children.length ,'files and folders');
        object.children.forEach( ( file:any, err:any ) => {
            if (err) console.error(err)
            downloadFiles(file, dlDir, path, realFilePath, bot, tgMsg, actualMsg, showProgress);
        })
    } else {
        let downloadStream = object.download();
        dirCount = dirCount === 'undefined' ? 0 : dirCount;
        targetStat.file[fileCount]={ name: object.name, parent: dirCount, size: object.size, isDownloaded: false, isUploaded: false };
        fileCount += 1;

        // Condition separating file and folder links
        /* Problems: 
             TG Rate limiting as each file maintains its own status msg
             Also each file send a separate status msg after upload completion
         */
        if (showProgress) {
            const progressStream = createFileProgressStream(object.name, object.size, dlDir, path, realFilePath, bot, tgMsg, actualMsg);
            downloadStream = downloadStream.pipe(progressStream);
            console.log('File:', object.name, '| Size:', fileSize(object.size));
        } else {
            let filePath=path.replace(constants.ARIA_DOWNLOAD_LOCATION + '/' + dlDir + '/', '')+'/'
            console.log('File:', object.name, '| Size:', fileSize(object.size));

            //TODO: Remove this if-else condition, once we find a way to upload folders
            const progressStream = createFileProgressStream(object.name, object.size, dlDir, path, realFilePath, bot, tgMsg, actualMsg);
            downloadStream = downloadStream.pipe(progressStream);
            let message = `Downloading: <code>${realFilePath}</code>\n(  File: ${filePath}${object.name} | Size: ${fileSize(object.size)}).${' '.repeat(10)}.`;
            msgTools.editMessage(bot, tgMsg, message);
        }
        downloadStream.on('end', () => {}).pipe(fs.createWriteStream(path + object.name));
        //console.log(targetStat.file);
    }
}

function createFileProgressStream (filename: string, length: number, dlDir: string, path: string, realFilePath: string , bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message) {

    const stream = progressStream({
        length,
        time: constants.STATUS_UPDATE_INTERVAL_MS ? constants.STATUS_UPDATE_INTERVAL_MS : 12000
    });

    //console.log('%s: 0% - 0 bytes of %s', filename, fileSize(length));

    stream.on('progress', (progress: any) => {
        let filePath= path.replace(constants.ARIA_DOWNLOAD_LOCATION + '/' + dlDir + '/', '') ==='' ? '': path.replace(constants.ARIA_DOWNLOAD_LOCATION + '/' + dlDir + '/', '') + '/'
        let message = `Downloading: <code>${filePath}${filename}</code>\n${Math.round(progress.percentage)}% processed ${fileSize(progress.transferred)} of ${fileSize(length)}\nSpeed: ${fileSize(progress.speed)} | ETA: ${progress.eta} s .`;
        msgTools.editMessage(bot, tgMsg, message);

        /*
        if (progress.eta === 0) {
            console.log('Download completed for',filename);
        }
        */
    });

    stream.on('finish', async () => {
        console.log('Download completed for',filename,'. Uploading...');
        await startFileUpload(dlDir, realFilePath, filename, bot, tgMsg, actualMsg, `Downloading: <code>${filename}</code>`);
        /*
        for (let i=0; i < Object.keys(targetStat.file).length ; i++) {
            if (targetStat.file[i]['name'] === filename) {
                await startFileUpload(dlDir, realFilePath, filename, bot, tgMsg, actualMsg, `Downloading: <code>${filename}</code>`);
            }
        }*/
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

function defaultDownloadCallback (error: any, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message) {
  if (error) {
    console.error(error)
    //msgTools.deleteMsg(bot, tgMsg);
    msgTools.sendMessage(bot, actualMsg, `Error: ${error.message}`);
    //process.exit(1)
  }
}

async function startFileUpload(dlDir: string, file: string, filename: string, bot: TelegramBot, tgMsg: TelegramBot.Message, actualMsg: TelegramBot.Message, message: string) {
    message += `\n\n✔File download complete, starting upload...`;
    msgTools.editMessage(bot, tgMsg, message);

    const { size } = fs.statSync(file);

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