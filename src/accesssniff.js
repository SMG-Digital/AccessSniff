/*
 * AccessSniff
 * https://yargalot@github.com/yargalot/AccessSniff
 *
 * Copyright (c) 2015 Steven John Miller
 * Licensed under the MIT license.
 */

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import Promise from 'bluebird';
import validator from 'validator';
import _ from 'underscore';
import logger from './logger';
import childProcess from 'child_process';
import phantom from 'phantomjs';

export default class Accessibility {
  constructor(options) {
    this.basepath = process.cwd();
    this.failTask = 0;
    this.log          = '';
    this.fileContents = '';

    this.defaults = {
      ignore: [],
      verbose: true,
      force: false,
      domElement: true,
      reportType: null,
      reportLevels: {
        notice: true,
        warning: true,
        error: true
      },
      reportLevelsArray: [],
      reportLocation : 'reports',
      accessibilityrc: true,
      accessibilityLevel: 'WCAG2A'
    };

    // Defaults options with input options
    _.defaults(options, this.defaults);

    // Find the accessibilityRc file
    const accessRcPath = `${this.basepath}/.accessibilityrc`;

    if (fs.exists(accessRcPath) && options.accessibilityrc) {
      const rcOptions = fs.readFileSync(accessRcPath, 'utf8');

      if (rcOptions) {
        options = _.extend(options, JSON.parse(rcOptions));
      }
    }

    // We need to convert the report levels to uppercase
    _.each(options.reportLevels, (value, key) => {
      if (value) {
        options.reportLevelsArray.push(key.toUpperCase());
      }
    });

    // Assign options to this
    this.options = options;
  }

  terminalLog(msg) {
    const msgSplit = msg.split('|');
    let message = {};

    // If the level type is ignored, then return null;
    if (_.contains(this.options.ignore, msgSplit[1])) {
      return null;
    }

    // Start the Logging if the the report level matches
    if (_.contains(this.options.reportLevelsArray, msgSplit[0])) {
      message = {
        heading: msgSplit[0],
        issue: msgSplit[1],
        element: {
          node: msgSplit[3],
          class: msgSplit[4],
          id: msgSplit[5]
        },
        position: this.getElementPosition(msgSplit[3]),
        description: msgSplit[2]
      };
    } else {
      message = null;
    }

    // If there is an error +1 the error stuff
    if (message && message.heading === 'ERROR') {
      this.failTask += 1;
    }

    // If verbose is true then push the output through to the terminal
    if (message && this.options.verbose) {
      logger.generalMessage(message);
    }

    // Return the message for reports
    return message;

  }

  getElementPosition(htmlString) {
    let position = {};
    const htmlArray = this.fileContents.split('\n');

    htmlArray.every((element, lineNumber) => {
      if (!element.match(htmlString)) {
        return true;
      }

      let columnNumber = 0;
      let colIndex = 0;
      const pattern = /(\s|\t)/g;

      while (element.charAt(colIndex).match(pattern)) {
        columnNumber++;
        colIndex++;
      }

      position.lineNumber = lineNumber;
      position.columnNumber = columnNumber;

      return false;

    });

    return position;

  }

  parseOutput(file, deferred) {
    // We need to split the input via newline to get message entries
    const fileMessages = file.split('\n');
    let messageLog = [];

    fileMessages.every(messageString => {

      // If a message comes through undefined, skip it.
      if (!messageString) {
        return true;
      }

      // Each message will return as an array, [messageType, messagePipe]
      // Message Pipe needs to be sent through to the terminal for parsing
      const message = JSON.parse(messageString);
      const messageType = message[0];
      const messagePipe = message[1];

      // If the type is wcaglint done hop out of the loop
      if (messageType === 'wcaglint.done') {
        return false;
      }

      // Check to see if the message is an array, and then send it
      //through to the terminal
      const messageOuput = Array.isArray(message) && this.terminalLog(messagePipe);

      // Push the returned message to the messageLog
      // Message output could be null so we dont need to push that
      if (messageOuput) {
        messageLog.push(messageOuput);
      }

      return true;

    });

    // Fullfill the passed promise
    deferred.fulfill(messageLog);
  }

  getUrlContents(url) {
    return new Promise(function(resolve, reject) {
      axios
        .get(url)
        .then(response => resolve(response))
        .catch(response => reject(response));
    });
  }

  getFileContents(file) {
    return fs.readFileSync(file, 'utf8');
  }

  fileResolver(file) {
    const deferredOutside = Promise.pending();

    // Set the filename for later
    this.options.fileName = path.basename(file, '.html');

    // Start Message
    logger.startMessage('Testing ' + file);

    // Get file contents
    if (validator.isURL(file)) {
      this.getUrlContents(file)
        .then(data => this.fileContents = data.data);
    } else if (file.indexOf('<html>') > -1) {
      this.fileContents = file;
    } else {
      this.fileContents = this.getFileContents(file);
    }

    // Call Phantom
    childProcess
      .execFile(phantom.path, [
        path.join(__dirname, './phantom.js'),
        file,
        this.options.accessibilityLevel
      ], (error, stdout) => {
        if (error) {
          logger.generalError(error);
          deferredOutside.fulfill(error);
        }

        this.parseOutput(stdout, deferredOutside);
      });

    return deferredOutside.promise;

  }

  run(filesInput) {
    const files = Promise.resolve(filesInput);

    return files
      .bind(this)
      .map(this.fileResolver, { concurrency: 1 })
      .then(messageLog => {
        let logs = {};

        filesInput.forEach((fileName, index) => logs[fileName] = messageLog[index]);

        return logs;
      })
      .catch(err => {
        logger.generalError('There was an error', err);
        return err;
      });
  }

}
