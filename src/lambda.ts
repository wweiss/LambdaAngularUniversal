import {Callback, Context, Handler} from "aws-lambda";
import * as fs from 'fs';
import * as mime from 'mime-types';
import 'zone.js/dist/zone-node';
import 'reflect-metadata';
import * as zlib from 'zlib';

import { enableProdMode } from '@angular/core';

import { NgModuleFactory, Type, CompilerFactory, Compiler, StaticProvider } from '@angular/core';
import { ResourceLoader } from '@angular/compiler';
import {
  INITIAL_CONFIG,
  renderModuleFactory,
  platformDynamicServer
} from '@angular/platform-server';

import { FileLoader } from './file-loader';
import {provideModuleMap} from "@nguniversal/module-map-ngfactory-loader";
import {join} from "path";
import {APP_BASE_HREF} from "@angular/common";
import {Logger} from "@bitblit/ratchet/dist/common/logger";

enableProdMode();
Logger.setLevelByName('debug');
const { AppServerModuleNgFactory, LAZY_MODULE_MAP } = require('../dist/server/main.bundle');



Logger.info("Using LAU version 3");




/**
 * These are the allowed options for the engine
 */
export interface NgSetupOptions {
  bootstrap: Type<{}> | NgModuleFactory<{}>;
  providers?: StaticProvider[];
}

/**
 * These are the allowed options for the render
 */
export interface RenderOptions extends NgSetupOptions {
  req: Request;
  res?: Response;
  url?: string;
  document?: string;
}

function gzip(input, options={}) : Promise<Buffer>{
  var promise = new Promise<Buffer>(function (resolve, reject) {
    zlib.gzip(input, options, function (error, result) {
      if (!error) resolve(result);else reject(error);
    });
  });
  return promise;
};

/**
 * This holds a cached version of each index used.
 */
const templateCache: { [key: string]: string } = {};

/**
 * Map of Module Factories
 */
const factoryCacheMap = new Map<Type<{}>, NgModuleFactory<{}>>();

/**
 * Get a factory from a bootstrapped module/ module factory
 */
function getFactory(
  moduleOrFactory: Type<{}> | NgModuleFactory<{}>, compiler: Compiler
): Promise<NgModuleFactory<{}>> {
  return new Promise<NgModuleFactory<{}>>((resolve, reject) => {
    // If module has been compiled AoT
    if (moduleOrFactory instanceof NgModuleFactory) {
      resolve(moduleOrFactory);
      return;
    } else {
      let moduleFactory = factoryCacheMap.get(moduleOrFactory);

      // If module factory is cached
      if (moduleFactory) {
        resolve(moduleFactory);
        return;
      }

      // Compile the module and cache it
      compiler.compileModuleAsync(moduleOrFactory)
        .then((factory) => {
          factoryCacheMap.set(moduleOrFactory, factory);
          resolve(factory);
        }, (err => {
          reject(err);
        }));
    }
  });
}

/**
 * Get the document at the file path
 */
function getDocument(filePath: string, baseHref:string): string {

  let cacheValue = templateCache[filePath];
  if (!cacheValue)
  {
    cacheValue = fs.readFileSync(filePath).toString();
    cacheValue = cacheValue.replace('<base href="/">','<base href="'+baseHref+'">');
    templateCache[filePath]=cacheValue;
  }
  debugger;
  return cacheValue;
}

function preProcess(event:any) : any{
  return event;
}


function shouldGzip(fileSize: number, contentType:string) : boolean {
  /*

  let rval : boolean = (fileSize>2048); // MTU packet is 1400 bytes
  if (rval && contentType) {
    let test : string = contentType.toLowerCase();
    if (test.startsWith("image/") && test.indexOf('svg')==-1)
    {
      rval = false;
    }
    else if (test=='application/pdf')
    {
      rval = false;
    }
  }

  return rval;
  */
  // May put this back in later
  return true;
}

function zipAndReturn(content:any, contentType:string, callback:Callback)
{
  if (shouldGzip(content.length,contentType)) {
    gzip(content).then((compressed) => {
      let contents64 = compressed.toString('base64');

      let response = {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': contentType,
          'content-encoding': 'gzip'
        },
        body: contents64
      };

      Logger.debug("Sending response with gzip body, length is %d", contents64.length);
      callback(null, response);
    });
  }
  else
    {
      let contents64 = content.toString('base64');

      let response = {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': contentType,
        },
        body: contents64
      };

      Logger.debug("Sending response with gzip body, length is %d", contents64.length);
      callback(null, response);

    }
}


/**
 * Bridge from a lambda event to angular universal
 * @param event
 * @param {Context} context
 * @param {Callback} callback
 */
const handler: Handler = (inEvent: any, context: Context, callback: Callback) => {
  let event = preProcess(inEvent);
  let canGZip : boolean = (event.headers['Accept-Encoding'] && event.headers['Accept-Encoding'].indexOf('gzip')>-1);
  let filePath = join(process.cwd(), 'browser', event.path);

  if (fs.existsSync(filePath)) {
    // Do something
    let contents : Buffer = fs.readFileSync(filePath);
    let contentType : string = mime.lookup(event.path);
    contentType = (contentType)?contentType:'application/octet-stream';

    Logger.debug("Read file %s and found %d bytes, clientGzip:%s",filePath, contents.length, canGZip);
    zipAndReturn(contents,contentType,callback);
  }
  else
  {
    // Render with Angular
    let filePath = join(process.cwd(), 'browser', "index.html");

    try {
      let setupOptions : NgSetupOptions=
        {
          bootstrap: AppServerModuleNgFactory,
          providers: [
            provideModuleMap(LAZY_MODULE_MAP)
          ]
        };
      //const moduleOrFactory = options.bootstrap || setupOptions.bootstrap;

      const moduleOrFactory = setupOptions.bootstrap;

      const compilerFactory: CompilerFactory = platformDynamicServer().injector.get(CompilerFactory);
      const compiler: Compiler = compilerFactory.createCompiler([
        {
          providers: [
            { provide: ResourceLoader, useClass: FileLoader, deps: [] }
          ]
        }
      ]);

      /*
      const baseHref =
        event['headers']['X-Forwarded-Proto']+"://"+
        event['headers']['Host']+'/'+
        event['requestContext']['stage'];
        */

      const baseHref = '/'+event['requestContext']['stage']+"/";

      // TODO: Query params

      const url = event.path;
      const doc = getDocument(filePath, baseHref);

      const extraProviders = setupOptions.providers.concat(
        //options.providers,
        //getReqResProviders(options.req, options.res),
        [
          {
            provide: INITIAL_CONFIG,
            useValue: {
              document: doc, // options.document || getDocument(filePath)
              url: url// options.url //|| options.req.originalUrl
            }
          },
          {
            provide: APP_BASE_HREF,
            useValue: baseHref
          }
        ]);

      Logger.debug("Evt : \n"+JSON.stringify(event));
      Logger.silly("Doc : \n"+doc);
      Logger.debug("Using url : "+url + " Base : "+baseHref+" FilePath: "+filePath);

      //const extraProviders = setupOptions.providers;

      getFactory(moduleOrFactory, compiler)
        .then(factory => {
          return renderModuleFactory(factory, {
            extraProviders
          });
        })
        .then((html: string) => {
          Logger.debug("About to write to output : %s",html);
          let contentType : string = 'text/html';
          // TODO: does this need to be a Buffer?
          zipAndReturn(html,contentType,callback);
        }, (err) => {
          callback(err);
        });
    } catch (err) {
      callback(err);
    }
  }

};

export {handler};
