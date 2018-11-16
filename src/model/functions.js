/**
 * Copyright 2017, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License")
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const _ = require('lodash');
const AdmZip = require('adm-zip');
const axios = require('axios');
const Configstore = require('configstore');
const fs = require('fs');
const logger = require('winston');
const os = require('os');
const path = require('path');
const rimraf = require('rimraf');
const spawn = require('child_process').spawn;
const Storage = require('@google-cloud/storage');
const uuid = require('uuid');

const CloudFunction = require('./cloudfunction');
const Errors = require('../utils/errors');
const Operation = require('./operation');
const pkg = require('../../package.json');
const Schema = require('../utils/schema');

const GCS_URL = /^gs:\/\/([A-Za-z0-9][\w-.]+[A-Za-z0-9])\/(.+)$/;

class ConfigAdapter {
  constructor (opts = {}) {
    this._functions = new Configstore(path.join(pkg.name, '.functions'));
    this._operations = new Configstore(path.join(pkg.name, '.operations'));
  }

  createFunction (cloudfunction) {
    return Promise.resolve()
      .then(() => {
        this._functions.set(cloudfunction.name, cloudfunction);
      });
  }

  createOperation (operation = {}) {
    return Promise.resolve()
      .then(() => {
        operation.name = `operations/${uuid.v4()}`;
        this._operations.set(operation.name, operation);
        return operation;
      });
  }

  deleteFunction (name) {
    return Promise.resolve()
      .then(() => {
        this._functions.delete(name);
      });
  }

  getFunction (name) {
    return Promise.resolve().then(() => this._functions.get(name));
  }

  getOperation (name) {
    return Promise.resolve().then(() => this._operations.get(name));
  }

  listFunctions (opts = {}) {
    return Promise.resolve()
      .then(() => {
        const cloudfunctionsObj = this._functions.all;
        const cloudfunctions = [];
        for (let name in cloudfunctionsObj) {
          cloudfunctions.push(cloudfunctionsObj[name]);
        }
        return {
          functions: cloudfunctions,
          nextPageToken: ''
        };
      });
  }

  updateOperation (name, operation) {
    return Promise.resolve()
      .then(() => {
        this._operations.set(name, operation);
        return operation;
      });
  }
}

const FunctionsConfigSchema = {
  type: 'object',
  properties: {
    storage: {
      type: 'string',
      enum: ['configstore']
    },
    host: {
      type: 'string'
    },
    supervisorPort: {
      type: 'number'
    }
  },
  required: ['storage', 'host', 'supervisorPort']
};

/**
 * TODO
 *
 * @class Functions
 * @param {object} config Configuration settings.
 * @returns {Functions}
 */
class Functions {
  constructor (config = {}) {
    const errors = Schema.validate(config, Functions.configSchema);
    if (errors) {
      const err = new Errors.InvalidArgumentError('CloudFunctions config is invalid!');
      err.details.push(new Errors.BadRequest(err, errors));
      throw err;
    }
    this.config = _.merge({}, config);
    if (this.config.storage === 'configstore') {
      this.adapter = new ConfigAdapter(this.config);
    }
  }

  /**
   * The schema for the config argument passed to the Functions constructor.
   *
   * @name Functions.configSchema
   * @type {object}
   */
  static get configSchema () {
    return FunctionsConfigSchema;
  }

  /**
   * Asserts that a CloudFunction with the given name does not already exist.
   *
   * @method Functions#_assertFunctionDoesNotExist
   * @private
   * @param {string} name The name of the CloudFunction.
   * @returns {Promise}
   */
  _assertFunctionDoesNotExist (name) {
    logger.debug('Functions#_assertFunctionDoesNotExist', name);
    return this.adapter.getFunction(name)
      .then((cloudfunction) => {
        if (cloudfunction) {
          const parts = CloudFunction.parseName(name);
          const err = new Errors.ConflictError(`Function ${parts.name} in location ${parts.location} in project ${parts.project} already exists`);
          logger.error(err);
          throw err;
        }
      });
  }

  _checkForPackageJson (dirName) {
    logger.debug('Functions#_checkForPackageJson', dirName);
    return new Promise((resolve, reject) => {
      fs.open(path.join(dirName, 'package.json'), 'r', (err) => resolve(!err));
    });
  }

  _checkForYarn (dirName) {
    logger.debug('Functions#_checkForYarn', dirName);
    return new Promise((resolve, reject) => {
      fs.open(path.join(dirName, 'yarn.lock'), 'r', (err) => resolve(!err));
    });
  }

  _installNpm (dirName) {
    logger.debug('Functions#_installNpm', dirName);
    return new Promise((resolve, reject) => {
      spawn('npm', ['install'], {
        cwd: dirName
      }).on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('Failed to install dependencies!'));
        }
      });
    });
  }

  _installYarn (dirName) {
    logger.debug('Functions#_installYarn', dirName);
    return new Promise((resolve, reject) => {
      spawn('yarn', ['install'], {
        cwd: dirName,
        stdio: 'inherit'
      }).on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error('Failed to install dependencies!'));
        }
      });
    });
  }

  _prepDir (dirName) {
    return this._checkForPackageJson(dirName)
      .then((hasPackageJson) => {
        if (hasPackageJson) {
          return this._checkForYarn(dirName)
            .then((hasYarn) => hasYarn ? this._installYarn(dirName) : this._installNpm(dirName));
        }
      });
  }

  _unpackArchive (cloudfunction) {
    logger.debug('Functions#_unpackArchive', cloudfunction);
    return Promise.resolve()
      .then(() => {
        const sourceArchiveUrl = cloudfunction.gcsUrl || cloudfunction.sourceArchiveUrl || '';
        let archive = CloudFunction.getArchive(cloudfunction);
        let localdir = CloudFunction.getLocaldir(cloudfunction);

        if (localdir) {
          logger.debug('Functions#_unpackArchive', 'Function will be loaded from local file system.');
          return cloudfunction;
        }

        logger.debug('Functions#_unpackArchive', 'Function source will be unpacked.');

        if (archive) {
          const zip = new AdmZip(archive);
          const parts = path.parse(archive);
          localdir = path.join(parts.dir, parts.name);
          CloudFunction.addLocaldir(cloudfunction, localdir);
          zip.extractAllTo(localdir);
          return this._prepDir(localdir)
            .then(() => this.adapter.createFunction(cloudfunction))
            .then(() => cloudfunction);
        } else if (sourceArchiveUrl.startsWith('gs://') && !archive) {
          const matches = sourceArchiveUrl.match(GCS_URL);
          if (!matches) {
            throw new Error(`Unsupported archive url: ${sourceArchiveUrl}`);
          }
          const parts = CloudFunction.parseName(cloudfunction.name);
          const storage = Storage({
            projectId: parts.project
          });
          const file = storage.bucket(matches[1]).file(matches[2]);

          cloudfunction.sourceUploadUrl = CloudFunction.generateUploadUrl(this.config);
          let zipName = CloudFunction.getArchive(cloudfunction);

          return file.download({ destination: zipName })
            .then(() => {
              const zip = new AdmZip(zipName);
              const parts = path.parse(zipName);
              localdir = path.join(parts.dir, parts.name);
              CloudFunction.addLocaldir(cloudfunction, localdir);
              zip.extractAllTo(localdir);

              return this._prepDir(localdir);
            })
            .then(() => this.adapter.createFunction(cloudfunction))
            .then(() => cloudfunction);
        } else {
          throw new Error(`Unsupported archive url: ${sourceArchiveUrl}`);
        }
      });
  }

  /**
   * Returns a new CloudFunction instance, initialized with the provided name
   * and properties.
   *
   * @method Functions#cloudfunction
   * @param {string} name The name of the CloudFunction.
   * @param {object} [props] Optional properties with which to initialize the
   *     CloudFunction instance.
   * @returns {CloudFunction} The new CloudFunction instance.
   */
  cloudfunction (name, props) {
    if (props instanceof CloudFunction) {
      return props;
    }
    return new CloudFunction(name, props);
  }

  /**
   * Formats an error used when there is a general error creating a
   * CloudFunction.
   *
   * @method Functions#_createFunctionError
   * @private
   * @param {string} name The name of the CloudFunction to create.
   * @param {object} err The error.
   * @returns {Promise}
   */
  _createFunctionError (name, err) {
    logger.error(err);
    err = new Errors.InternalError(err.message);
    return Promise.reject(err);
  }

  /**
   * Creates a CloudFunction.
   *
   * @method Functions#createFunction
   * @param {string} location The location for the new CloudFunction.
   * @param {object} cloudfunction The CloudFunction configuration.
   * @returns {Promise}
   */
  createFunction (location, cloudfunction = {}) {
    let operation, request;
    logger.debug('Functions#createFunction', location, cloudfunction);

    return Promise.resolve()
      .then(() => {
        request = {
          location,
          function: _.cloneDeep(cloudfunction)
        };

        if (request.function.gcsUrl) {
          request.function.sourceArchiveUrl = request.function.gcsUrl;
          delete request.function.gcsUrl;
        }
        for (let key in request.function) {
          if (!request.function[key]) {
            delete request.function[key];
          }
        }

        logger.debug(JSON.stringify(request.function, null, 2));

        // TODO: Filter out fields that cannot be edited by the user
        cloudfunction = this.cloudfunction(cloudfunction.name, cloudfunction);
      })
      .catch((err) => this._createFunctionError(cloudfunction.name, err))
      .then(() => this._assertFunctionDoesNotExist(cloudfunction.name))
      .then(() => {
        const parts = CloudFunction.parseName(cloudfunction.name);

        cloudfunction.status = 'DEPLOYING';
        if (cloudfunction.httpsTrigger) {
          cloudfunction.httpsTrigger.url = `http://${this.config.host}:${this.config.supervisorPort}/${parts.project}/${parts.location}/${parts.name}`;
        }

        // Prepare the Operation
        operation = this.operation(Operation.generateId(), {
          done: false,
          metadata: {
            typeUrl: 'types.googleapis.com/google.cloud.functions.v1beta2.OperationMetadataV1Beta2',
            value: {
              target: cloudfunction.name,
              type: 1,
              request: {
                typeUrl: 'types.googleapis.com/google.cloud.functions.v1beta2.CreateFunctionRequest',
                value: request
              }
            }
          }
        });

        return Promise.all([
          this.adapter.createFunction(cloudfunction),
          this.adapter.createOperation(operation)
        ]);
      })
      .then(() => {
        // Deploy the function out of band
        setImmediate(() => {
          cloudfunction.latestOperation = operation.name;
          cloudfunction.availableMemoryMb = Math.floor(os.totalmem() / 1000000);

          // Create the CloudFunction
          this._unpackArchive(cloudfunction)
            .then((_cloudfunction) => {
              cloudfunction = _cloudfunction;

              return new Promise((resolve, reject) => {
                setTimeout(() => {
                  return axios.request({
                    url: `${this.getSupervisorHost()}/api/deploy`,
                    method: 'POST',
                    data: {
                      name: cloudfunction.name
                    }
                  }).then(resolve, (err) => {
                    if (err && err.response && err.response.body) {
                      if (err.response.body.error) {
                        err = err.response.body.error;
                      } else {
                        err = err.response.body;
                      }
                    }
                    reject(err);
                  });
                }, 2000);
              });
            })
            .then(() => {
              cloudfunction.status = 'READY';
              operation.done = true;
              operation.response = {
                typeUrl: 'types.googleapis.com/google.cloud.functions.v1beta2.CloudFunction',
                value: _.cloneDeep(cloudfunction)
              };

              return Promise.all([
                // Fire off the request to update the Operation
                this.adapter.updateOperation(operation.name, operation),
                this.adapter.createFunction(cloudfunction)
              ]);
            })
            .catch((err) => this._createFunctionError(cloudfunction.name, err))
            .catch((err) => {
              cloudfunction.status = 'FAILED';
              operation.done = true;
              operation.error = JSON.parse(JSON.stringify(err));

              return Promise.all([
                // Fire off the request to update the Operation
                this.adapter.updateOperation(operation.name, operation),
                this.adapter.createFunction(cloudfunction)
              ]);
            })
            .catch(logger.error);
        });

        // Return the operation to the caller
        return operation;
      });
  }

  /**
   * Formats an error used when there is a general error deleting a
   * CloudFunction.
   *
   * @method Functions#_deleteFunctionError
   * @private
   * @param {string} name The name of the CloudFunction to delete.
   * @param {object} err The error.
   * @param {Operation} operation The in-flight Operation, if any.
   * @returns {Promise}
   */
  _deleteFunctionError (name, err, operation) {
    err = new Errors.InternalError(err.message);

    if (operation) {
      operation.done = true;
      operation.error = _.cloneDeep(err);

      // Fire off the request to update the Operation
      this.adapter.updateOperation(operation.name, operation)
        .catch((err) => this._deleteFunctionError(name, err));
    }

    logger.error(err);
    return Promise.reject(err);
  }

  /**
   * Deletes a CloudFunction.
   *
   * @method Functions#deleteFunction
   * @param {string} name The name of the CloudFunction to delete.
   * @returns {Promise}
   */
  deleteFunction (name) {
    logger.debug('Functions#deleteFunction', name);
    return this.getFunction(name)
      .then((cloudfunction) => {
        const operationName = Operation.generateId();

        // Prepare the Operation
        const operation = this.operation(operationName, {
          done: false,
          metadata: {
            typeUrl: 'types.googleapis.com/google.cloud.functions.v1beta2.OperationMetadataV1Beta2',
            value: {
              target: name,
              type: 1,
              request: {
                typeUrl: 'types.googleapis.com/google.cloud.functions.v1beta2.DeleteFunctionRequest',
                value: { name }
              }
            }
          }
        });

        // Save the Operation
        return this.adapter.createOperation(operation)
          .then(() => {
            // Asynchronously perform the deletion of the CloudFunction
            setImmediate(() => {
              const archive = CloudFunction.getArchive(cloudfunction);
              const localdir = CloudFunction.getLocaldir(cloudfunction);
              if (archive) {
                try {
                  fs.unlinkSync(archive);
                } catch (err) {
                  // Ignore error
                }
                if (localdir && archive.startsWith(localdir)) {
                  try {
                    rimraf.sync(localdir);
                  } catch (err) {
                    // Ignore error
                  }
                }
              }

              // Delete the CloudFunction
              this.adapter.deleteFunction(name)
                .then(() => {
                  return axios.request({
                    url: `${this.getSupervisorHost()}/api/delete`,
                    method: 'POST',
                    data: {
                      name: cloudfunction.name
                    }
                  });
                })
                .then(() => {
                  operation.done = true;
                  operation.response = {
                    typeUrl: 'types.googleapis.com/google.protobuf.Empty',
                    value: {}
                  };

                  // Fire off the request to update the Operation
                  this.adapter.updateOperation(operation.name, operation)
                    .catch((err) => this._deleteFunctionError(name, err));
                }, (err) => this._deleteFunctionError(name, err, operation));
            });

            // Synchronously return the Operation instance
            return operation;
          }, (err) => this._deleteFunctionError(name, err));
      });
  }

  /**
   * Formats an error used when a requested CloudFunction does not exist.
   *
   * @method Functions#_getFunctionNotFoundError
   * @private
   * @param {string} name The name of the requested CloudFunction.
   * @returns {Promise}
   */
  _getFunctionNotFoundError (name) {
    const parts = CloudFunction.parseName(name);
    const err = new Errors.NotFoundError(`Function ${parts.name} in location ${parts.location} in project ${parts.project} does not exist`);
    return Promise.reject(err);
  }

  /**
   * Formats an error used when there is a general error retrieving a
   * CloudFunction.
   *
   * @method Functions#_getFunctionError
   * @private
   * @param {string} name The name of the requested CloudFunction.
   * @param {object} err The error.
   * @returns {Promise}
   */
  _getFunctionError (name, err) {
    err = new Errors.InternalError(err.message);
    logger.error(err);
    return Promise.reject(err);
  }

  /**
   * Gets a CloudFunction.
   *
   * @method Functions#getFunction
   * @param {string} name The name of the requested CloudFunction.
   * @returns {Promise}
   */
  getFunction (name) {
    logger.debug('Functions#getFunction', name);
    return this.adapter.getFunction(name)
      .then((cloudfunction) => {
        if (!cloudfunction) {
          return this._getFunctionNotFoundError(name);
        }

        return this.cloudfunction(name, cloudfunction);
      }, (err) => this._getFunctionError(name, err));
  }

  getSupervisorHost () {
    return `http://${this.config.bindHost}:${this.config.supervisorPort}`;
  }

  /**
   * Formats an error used when a requested Operation does not exist.
   *
   * @method Functions#_getOperationNotFoundError
   * @private
   * @param {string} name The name of the requested Operation.
   * @returns {Promise}
   */
  _getOperationNotFoundError (name) {
    const err = new Errors.NotFoundError(`Operation ${name} does not exist`);
    return Promise.reject(err);
  }

  /**
   * Formats an error used when there is a general error retrieving an
   * Operation.
   *
   * @method Functions#_getOperationError
   * @private
   * @param {string} name The name of the requested Operation.
   * @param {objects} err The error.
   * @returns {Promise}
   */
  _getOperationError (name, err) {
    err = new Errors.InternalError(err.message);
    logger.error(err);
    return Promise.reject(err);
  }

  /**
   * Gets an Operation.
   *
   * @method Functions#getOperation
   * @param {string} name The name of the requested Operation.
   * @returns {Promise}
   */
  getOperation (name) {
    logger.debug('Functions#getOperation', name);
    return this.adapter.getOperation(name)
      .then((operation) => {
        if (!operation) {
          return this._getOperationNotFoundError(name);
        }

        return this.operation(name, operation);
      }, (err) => this._getOperationError(err));
  }

  /**
   * Lists CloudFunction.
   *
   * @method Functions#listFunctions
   * @param {string} location The project and location from which
   *     the CloudFunctions should be listed, specified in the format:
   *         projects/PROJECT/locations/LOCATION
   *     If you want to list functions in all locations, use '-' in place of a
   *     location.
   * @param {object} [opts] Configuration options.
   * @param {number} [opts.pageSize] Maximum number of functions to return.
   * @param {string} [opts.pageToken] The value returned by the last
   *     ListFunctionsResponse; indicates that this is a continuation of a prior
   *     ListFunctions call, and that the system should return the next page of
   *     data.
   * @returns {Promise}
   */
  listFunctions (location, opts = {}) {
    return Promise.resolve()
      .then(() => {
        // TODO: Convert these to the proper format
        if (!location) {
          throw new Error('"location" is required!');
        } else if (typeof location !== 'string') {
          throw new Error('"location" must be a string!');
        } else if (opts && opts.pageSize) {
          opts.pageSize = parseInt(opts.pageSize, 10);
          if (isNaN(opts.pageSize) || typeof opts.pageSize !== 'number') {
            throw new Error('"pageSize" must be a number!');
          }
        } else if (opts && opts.pageToken && typeof opts.pageToken !== 'string') {
          throw new Error('"pageToken" must be a string!');
        }

        return this.adapter.listFunctions(opts);
      })
      .then((response) => {
        response.functions = response.functions.map((func) => this.cloudfunction(func.name, func));
        return response;
      });
  }

  /**
   * Returns a new Operation instance, initialized with the provided name and
   * properties.
   *
   * @method Functions#operation
   * @param {string} name The name of the Operation.
   * @param {object} [props] Optional properties with which to initialize the
   *     Operation instance.
   * @returns {Operation} The new Operation instance.
   */
  operation (name, props) {
    if (props instanceof Operation) {
      return props;
    }
    return new Operation(name, props);
  }
}

module.exports = Functions;
