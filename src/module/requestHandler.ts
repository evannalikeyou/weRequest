import loading from '../util/loading'
import config from '../store/config'
import status from '../store/status'
import mockManager from './mockManager'
import cacheManager from './cacheManager'
import sessionManager from './sessionManager'
import responseHandler from './responseHandler'
import durationReporter from './durationReporter'
import url from '../util/url'
import {IRequestOption, IUploadFileOption, IErrorObject} from '../interface'
import { catchHandler } from './catchHandler'

// 格式化url
function format(originUrl: string) {
    if (originUrl.startsWith('http')) {
        return originUrl
    } else {
        let urlPerfix = config.urlPerfix;
        if (typeof config.urlPerfix === "function") {
            urlPerfix = config.urlPerfix()
        }
        return urlPerfix + originUrl;
    }
}

// 所有请求发出前需要做的事情
function preDo<T extends IRequestOption | IUploadFileOption>(obj: T): T {
    // 登录态失效，重复登录计数
    if (typeof obj.reLoginCount === "undefined") {
        obj.reLoginCount = 0;
    } else {
        obj.reLoginCount++;
    }

    if (obj.reLoginCount === 0 && typeof obj.beforeSend === "function") {
        obj.beforeSend();
    }

    if (obj.showLoading) {
        loading.show(obj.showLoading);
    }

    if (!obj.originUrl) {
        obj.originUrl = obj.url;
        obj.url = format(obj.url);
    }

    return obj;
}

// 格式化处理请求的obj内容
function initializeRequestObj(obj: IRequestOption, js_code: string|undefined) {

    if (!obj.data) {
        obj.data = {};
    }

    obj.header = obj.header ? obj.header : {};
    if (typeof config.setHeader === 'function') {
        let header = (config.setHeader as (()=> WechatMiniprogram.IAnyObject))();
        if (typeof header === 'object') {
            obj.header = {...obj.header, ...header};
        }
    } else if (typeof config.setHeader === 'object') {
        obj.header = {...obj.header, ...config.setHeader};
    }

    if (js_code) {
        obj.data = {...obj.data as object, [config.codeName as string]: js_code};
    } else if (status.session) {
        obj.data = {...obj.data as object, [config.sessionName as string]: status.session};
    }

    // 如果有全局参数，则添加
    const gd = getGlobalData();
    obj.data = {...gd, ...obj.data as object};

    obj.method = obj.method || 'GET';
    obj.dataType = obj.dataType || 'json';

    // 如果请求不是GET，则在URL中自动加上登录态和全局参数
    if (!config.doNotUseQueryString && obj.method !== "GET") {
        if(js_code) {
            obj.url = url.setParams(obj.url, {[config.codeName as string]: js_code});
        } else if (status.session) {
            obj.url = url.setParams(obj.url, {[config.sessionName as string]: status.session});
        }
        obj.url = url.setParams(obj.url, gd);
    }

    // 备用域名逻辑
    obj.url = url.replaceDomain(obj.url);

    durationReporter.start(obj);

    return obj;
}

// 格式化处理上传文件的obj内容
function initializeUploadFileObj(obj: IUploadFileOption, js_code: string|undefined) {
    if (!obj.formData) {
        obj.formData = {};
    }

    obj.header = obj.header ? obj.header : {};
    if (typeof config.setHeader === 'function') {
        let header = (config.setHeader as (()=> WechatMiniprogram.IAnyObject))();
        if (typeof header === 'object') {
            obj.header = {...obj.header, ...header};
        }
    } else if (typeof config.setHeader === 'object') {
        obj.header = {...obj.header, ...config.setHeader};
    }

    if (js_code) {
        obj.formData = {...obj.formData as object, [config.codeName as string]: js_code};
    } else if (status.session) {
        obj.formData = {...obj.formData as object, [config.sessionName as string]: status.session};
    }

    // 如果有全局参数，则添加
    const gd = getGlobalData();
    obj.formData = {...gd, ...obj.formData};

    if (!config.doNotUseQueryString) {
        // 将登陆态也带在url上
        if (js_code) {
            obj.url = url.setParams(obj.url, {[config.codeName as string]: js_code});
        } else if (status.session) {
            obj.url = url.setParams(obj.url, {[config.sessionName as string]: status.session});
        }
        // 全局参数同时放在url上
        obj.url = url.setParams(obj.url, gd);
    }

    // 备用域名逻辑
    obj.url = url.replaceDomain(obj.url);

    durationReporter.start(obj);

    return obj;
}

function getGlobalData() {
    let gd: any = {};
    if (typeof config.globalData === "function") {
        gd = config.globalData();
    } else if (typeof config.globalData === "object") {
        gd = config.globalData;
    }
    return gd;
}

function doRequest(obj: IRequestOption, js_code: string|undefined) {
    obj = initializeRequestObj(obj, js_code);
    if (obj.reLoginCount === 0 && typeof config.beforeSend === "function") {
        obj = config.beforeSend(obj, js_code, status.session);
    }
    return new Promise((resolve, reject) => {
        wx.request({
            ...obj,
            success(res: WechatMiniprogram.RequestSuccessCallbackResult) {
                return resolve(res);
            },
            fail(res: WechatMiniprogram.GeneralCallbackResult) {
                // 如果主域名不可用，且配置了备份域名，且本次请求未使用备份域名
                if ((res?.errMsg?.indexOf('CONNECTION_REFUSED') >= 0 || res?.errMsg?.indexOf('ERR_CONNECTION_RESET') >= 0) && url.isInBackupDomainList(obj.url)) {
                    // 开启备份域名
                    enableBackupDomain(obj.url);
                    // 重试一次
                    return doRequest(obj, js_code).then((res)=> resolve(res));
                }
                return reject({ type: 'system-error', res });
            },
            complete() {
                if (typeof obj.complete === "function") {
                    obj.complete();
                }
                if (obj.showLoading) {
                    loading.hide();
                }
            }
        })
    })
}

function doUploadFile(obj: IUploadFileOption, js_code: string|undefined) {
    obj = initializeUploadFileObj(obj, js_code);
    if (obj.reLoginCount === 0 && typeof config.beforeSend === "function") {
        obj = config.beforeSend(obj, js_code, status.session);
    }
    return new Promise((resolve, reject) => {
        wx.uploadFile({
            url: obj.url,
            filePath: obj.filePath || '',
            name: obj.name || '',
            formData: obj.formData,
            success(res: WechatMiniprogram.UploadFileSuccessCallbackResult) {
                return resolve(res);
            },
            fail(res: WechatMiniprogram.GeneralCallbackResult) {
                // 如果主域名不可用，且配置了备份域名，且本次请求未使用备份域名
                if ((res?.errMsg?.indexOf('CONNECTION_REFUSED') >= 0 || res?.errMsg?.indexOf('ERR_CONNECTION_RESET') >= 0) && url.isInBackupDomainList(obj.url)) {
                    // 开启备份域名
                    enableBackupDomain(obj.url);
                    // 重试一次
                    return doUploadFile(obj, js_code).then((res)=> resolve(res));
                }
                return reject({ type: 'system-error', res });
            },
            complete() {
                if (typeof obj.complete === "function") {
                    obj.complete();
                }
                if (obj.showLoading) {
                    loading.hide();
                }
            }
        })
    })
}

function request<TResp>(obj: IRequestOption): Promise<TResp> {

    return new Promise((resolve, reject) => {

        obj = preDo(obj);

        if (config.mockJson) {
            let mockResponse = mockManager.get(obj);
            if (mockResponse) {
                let response = responseHandler.responseForRequest(mockResponse, obj);
                return resolve(response);
            }
        }

        if (obj.cache) {
            cacheManager.get(obj);
        }

        sessionManager.main().then((js_code: string) => {
            return doRequest(obj, js_code)
        }).then((res: WechatMiniprogram.RequestSuccessCallbackResult) => {
            let response = responseHandler.responseForRequest(res, obj);
            return resolve(response);
        }).catch((e: IErrorObject) => {
            return catchHandler(e, obj, reject)
        })

    })
}

function uploadFile(obj: IUploadFileOption): any {

    return new Promise((resolve, reject) => {

        obj = preDo(obj);

        if (config.mockJson) {
            let mockResponse = mockManager.get(obj);
            if (mockResponse) {
                let response = responseHandler.responseForUploadFile(mockResponse, obj);
                return resolve(response);
            }
        }

        sessionManager.main().then((js_code: string) => {
            return doUploadFile(obj, js_code);
        }).then((res: WechatMiniprogram.UploadFileSuccessCallbackResult) => {
            let response = responseHandler.responseForUploadFile(res, obj);
            return resolve(response);
        }).catch((e: IErrorObject) => {
            return catchHandler(e, obj, reject)
        })
    })
}

function enableBackupDomain(url: string = "") {
    if (!status.isEnableBackupDomain) {
        status.isEnableBackupDomain = true;
        if (typeof config.backupDomainEnableCallback === 'function') {
            config.backupDomainEnableCallback(url);
        }
    }
}

export default {
    format,
    request,
    uploadFile
}
