/// <reference path="../typings/parasoft-em-api.d.ts" />

import http = require('http');
import https = require('https');
import FormData = require('form-data');
import q = require('q');
import url = require('url');
import fs = require('fs');
import tl = require('azure-pipelines-task-lib/task');

class WebService {
    private baseURL: url.Url;
    private protocol: typeof https | typeof http;
    private protocolLabel: string;
    private authorization: tl.EndpointAuthorization;

    constructor(endpoint : string, context: string, authorization? : tl.EndpointAuthorization) {
        this.baseURL = url.parse(endpoint);
        if (this.baseURL.path === '/') {
            this.baseURL.path += context;
        } else if (this.baseURL.path === '/em/') {
            this.baseURL.path = '/' + context;
        }
        this.authorization = authorization;
        this.protocol = this.baseURL.protocol === 'https:' ? https : http;
        this.protocolLabel = this.baseURL.protocol || 'http:';
    }

    public performGET<T>(path : string, handler?: (res: http.IncomingMessage, def : q.Deferred<T>, responseStr: string) => void) : q.Promise<T>{
        var def = q.defer<T>();
        var options : http.RequestOptions = {
            host: this.baseURL.hostname,
            path: this.baseURL.path + path,
            auth: undefined,
            headers: {
                'Accept': 'application/json'
            }
        }
        if (this.baseURL.port)  {
            options.port = parseInt(this.baseURL.port);
        }
        if (this.protocolLabel === 'https:') {
            options['rejectUnauthorized'] = false;
            options['agent'] = false;
        }
        if (this.authorization && this.authorization.parameters['username']) {
            options.auth = this.authorization.parameters['username'] + ':' + this.authorization.parameters['password'];
        }
        console.log('GET ' + this.protocolLabel + '//' + options.host + (options.port ? ':' + options.port : "") + options.path);
        var responseString = "";
        this.protocol.get(options, (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                responseString += chunk;
            });
            res.on('end', () => {
                if (res.statusCode === 302) {
                    var redirectPath: string = res.headers.location;
                    if (redirectPath.startsWith(this.baseURL.path)) {
                        redirectPath = redirectPath.substring(3);
                    }
                    console.log('    redirect to "' + redirectPath + '"')
                    this.performGET<T>(redirectPath, handler).then(response => def.resolve(response));
                } else if (handler) {
                    handler(res, def, responseString);
                } else {
                    console.log('    response ' + res.statusCode + ':  ' + responseString);
                    var responseObject = JSON.parse(responseString);
                    def.resolve(responseObject);
                }
            });
        }).on('error', (e) => {
            def.reject(e);
        });
        return def.promise;
    }

    public performPUT<T>(path : string, data: any) : q.Promise<T> {
        return this.performRequest(path, data, 'PUT');
    }

    public performPOST<T>(path : string, data: any) : q.Promise<T> {
        return this.performRequest(path, data, 'POST');
    }

    private performRequest<T>(path : string, data: any, method : 'POST' | 'PUT') : q.Promise<T> {
        var def = q.defer<T>();
        var options : http.RequestOptions = {
            host: this.baseURL.hostname,
            path: this.baseURL.path + path,
            method: method,
            auth: undefined,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        }
        if (this.baseURL.port)  {
            options.port = parseInt(this.baseURL.port);
        }
        if (this.protocolLabel === 'https:') {
            options['rejectUnauthorized'] = false;
            options['agent'] = false;
        }
        if (this.authorization && this.authorization.parameters['username']) {
            options.auth = this.authorization.parameters['username'] + ':' + this.authorization.parameters['password'];
        }
        console.log(method + ' ' + this.protocolLabel + '//' + options.host + (options.port ? ':' + options.port : "") + options.path);
        var responseString = "";
        var req = this.protocol.request(options, (res) => {
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                responseString += chunk;
            });
            res.on('end', () => {
                console.log('    response ' + res.statusCode + ':  ' + responseString);
                var responseObject = JSON.parse(responseString);
                def.resolve(responseObject);
            });
        }).on('error', (e) => {
            def.reject(e);
        });
        req.write(JSON.stringify(data));
        req.end();
        return def.promise;
    }
}

var ctpEndpoint = tl.getInput('ParasoftEMEndpoint', true);
var ctpService = new WebService(tl.getEndpointUrl(ctpEndpoint, true), 'em', tl.getEndpointAuthorization(ctpEndpoint, true));
var dtpService = null;
var dtpEndpoint = tl.getInput('ParasoftDTPEndpoint', false);
var dtpAuthorization = tl.getEndpointAuthorization(dtpEndpoint, false);
if (dtpEndpoint) {
    var dtpEndpoint = tl.getInput('ParasoftDTPEndpoint', false);
    dtpService = new WebService(tl.getEndpointUrl(dtpEndpoint, false), 'grs', dtpAuthorization)
}
var abortOnTimout = tl.getBoolInput('AbortOnTimeout', false);
var timeout = tl.getInput('TimeoutInMinutes', false);

function uploadFile<T>() {
    var def = q.defer<T>();
    dtpService.performGET('/api/v1.6/services').then((response: any) => {
        var dataCollectorURL = url.parse(response.services.dataCollectorV2);
        var form = new FormData()
        var protocol : 'https:' | 'http:' = dataCollectorURL.protocol === 'https:' ? 'https:' : 'http:';
        form.append('file', fs.createReadStream('report.xml'));
        var options : FormData.SubmitOptions = {
            host: dataCollectorURL.hostname,
            port: parseInt(dataCollectorURL.port),
            path: dataCollectorURL.path,
            method: 'POST',
            protocol: protocol,
            headers : form.getHeaders()
        }
        if (protocol === 'https:') {
            options['rejectUnauthorized'] = false;
            options['agent'] = false;
            if (dtpAuthorization && dtpAuthorization.parameters['username']) {
                options.auth = dtpAuthorization.parameters['username'] + ':' + dtpAuthorization.parameters['password'];
            }
        }
        console.log('POST ' + options.protocol + '//' + options.host + (options.port ? ':' + options.port : "") + options.path);
        form.submit(options, (err, res) => {
            if (err) {
                return def.reject(new Error(err.message))
            }
            if (res.statusCode < 200 || res.statusCode > 299) {
                return def.reject(new Error(`HTTP status code ${res.statusCode}`))
            }
            var body = []
            res.on('data', (chunk) => body.push(chunk))
            res.on('end', () => {
                var resString : any = Buffer.concat(body).toString();
                def.resolve(resString);
            })
        })
    }).catch((error) => {
        def.reject(error);
    });
    return def.promise;
}

function publishReport(reportId : number) : q.Promise<void> {
    var def = q.defer<void>();
    ctpService.performGET("/testreport/" + reportId + "/report.xml",  (res, def, responseStr) => { 
        def.resolve(responseStr)
    }).then((xmlFile: any) => {
        fs.writeFile('report.xml', xmlFile, (err) => {
            if (err) {
                def.reject(err);
            }
            if ( fs.existsSync('report.xml')) {
                console.log('report.xml file succesfully downloaded');
            }
            uploadFile().then(response => {
                console.log('upload file response type: ' + typeof response);
                console.log(response);
            }).catch((error) => {
                console.log(error);
                tl.error("Error while uploading report.xml file");
            });
        });
    });
    return def.promise;
}

var jobName = tl.getInput('Job', true);
var jobId;
ctpService.performGET('/api/v2/jobs', (res, def, responseStr) => {
    console.log('    response ' + res.statusCode + ':  ' + responseStr);
    var responseObject = JSON.parse(responseStr);
    if (typeof responseObject['jobs'] === 'undefined') {
        def.reject('jobs' + ' does not exist in response object from /api/v2/jobs');
        return;
    }
    for (var i = 0; i < responseObject['jobs'].length; i++) {
        if (responseObject['jobs'][i].name === jobName) {
            def.resolve(responseObject['jobs'][i]);
            return;
        }
    }
    def.reject('Could not find name "' + jobName + '" in jobs from /api/v2/jobs');
}).then((job: EMJob) => {
    tl.debug('Found job ' + job.name + ' with id ' + job.id);
    jobId = job.id;
    return ctpService.performPOST<EMJobHistory>('/api/v2/jobs/' + jobId + '/histories?async=true', {});
}) .then((res: EMJobHistory) => {
    var historyId = res.id;
    var status = res.status;
    var startTime = new Date().getTime();
    var checkStatus = function() {
        ctpService.performGET<EMJobHistory>('/api/v2/jobs/' + jobId + '/histories/' + historyId).then((res: EMJobHistory) => {
            status = res.status;
            if (abortOnTimout) {
                var timespent = (new Date().getTime() - startTime) / 60000,
                    timeoutNum = parseInt(timeout);
                if (timespent > timeoutNum) {
                    ctpService.performPUT('/api/v2/jobs/' + jobId + '/histories/' + historyId, {status : 'CANCELED'});
                    tl.error("Test execution job timed out after " + timeoutNum + " minute" + (timeoutNum > 1 ? 's' : "") + '.');
                    tl.setResult(tl.TaskResult.Failed, 'Job ' + tl.getInput('Job', true) + ' timed out.');
                    return;
                }
            }
            if (status === 'RUNNING' || status === 'WAITING') {
                setTimeout(checkStatus, 1000);
            } else if (status === 'PASSED') {
                tl.debug('Job ' + tl.getInput('Job', true) + ' passed.');
                if (dtpService) {
                    res.reportIds.forEach((reportId) => {
                        console.log('    report location: ' + "/testreport/" + reportId + "/report.xml");
                        publishReport(reportId).catch(err => {
                            tl.error("Failed to publish report to DTP");
                        });
                    });
                } 
                tl.setResult(tl.TaskResult.Succeeded, 'Job ' + tl.getInput('Job', true) + ' passed.');
            } else if (status === 'CANCELED') {
                tl.warning('Job ' + tl.getInput('Job', true) + ' canceled.');
                tl.setResult(tl.TaskResult.Succeeded, 'Job ' + tl.getInput('Job', true) + ' canceled.');
            } else {
                tl.error('Job ' + tl.getInput('Job', true) + ' failed.');
                if (dtpService) {
                    res.reportIds.forEach((reportId) => {
                        console.log('    report location: ' + "/testreport/" + reportId + "/report.xml");
                        publishReport(reportId).catch(err => {
                            tl.error("Failed to publish report to DTP");
                        });
                    });
                }
                tl.setResult(tl.TaskResult.Failed, 'Job ' + tl.getInput('Job', true) + ' failed.');
            }
        });
    };
    if (status === 'RUNNING' || status === 'WAITING') {
        setTimeout(checkStatus, 1000);
    }
}).catch((e) => {
    tl.error(e);
    tl.setResult(tl.TaskResult.Failed, e);
});
