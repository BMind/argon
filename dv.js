/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const {DateTime} = require('luxon');
const {GoogleAuth} = require('google-auth-library');

const {CSVExtractorBase} = require('./helpers.js');

const REPORTING_SCOPES = [
  'https://www.googleapis.com/auth/doubleclickbidmanager',
];
const REPORTING_BASE_URL =
  'https://www.googleapis.com/doubleclickbidmanager/v1';

const REPORT_AVAILABLE = 'DONE';
const GCS_URL_PATTERN = /(.*)\/(?<filename>.*)_(.*)_(.*)_(.*)_(.*)\.csv\?(.*)/;
const DATE_PATTERN = /(\d{4})\/(\d{2})\/(\d{2})/;

function convertDate(line) {
  return line.replace(new RegExp(DATE_PATTERN, 'g'), '$1-$2-$3');
}

function extractFilename(url) {
  const match = GCS_URL_PATTERN.exec(url);
  if (!match || !match.groups.filename) {
    throw Error('Unable to extract filename from URL.');
  }
  return match.groups.filename;
}

async function getClient(credentials) {
  const auth = new GoogleAuth();
  return auth.getClient({
    scopes: REPORTING_SCOPES,
    credentials,
  });
}

async function getReportName({client, reportId}) {
  const url = `${REPORTING_BASE_URL}/queries/${reportId}/reports`;
  const response = await client.request({url});
  if (
    !response.data ||
    !response.data.reports ||
    response.data.reports.length === 0
  ) {
    throw Error('Invalid or empty API response.');
  }

  let fileUrl = '';
  for (const report of response.data.reports) {
    if (report.metadata.status.state === REPORT_AVAILABLE) {
      fileUrl = report.metadata.googleCloudStoragePath;
      break;
    }
  }
  return extractFilename(fileUrl);
}

async function getReports({
  client,
  reportId,
  requiredDates,
  lookbackDays,
  dateFormat,
}) {
  const today = DateTime.utc();
  const reports = {};

  const url = `${REPORTING_BASE_URL}/queries/${reportId}/reports`;
  const response = await client.request({url});
  if (
    !response.data ||
    !response.data.reports ||
    response.data.reports.length === 0
  ) {
    throw Error('Invalid or empty API response.');
  }

  let latestDate = null;
  for (const report of response.data.reports) {
    if (report.metadata.status.state === REPORT_AVAILABLE) {
      const reportTimestamp = DateTime.fromMillis(
          Number.parseInt(report.metadata.reportDataEndTimeMs)
      );
      const reportDate = reportTimestamp.toFormat(dateFormat);
      if (requiredDates.delete(reportDate)) {
        reports[reportDate] = {
          url: report.metadata.googleCloudStoragePath,
          file: report.key.reportId,
        };
      }
      latestDate = reportTimestamp;
    }

    if (requiredDates.length === 0) {
      break; // no required dates remaining
    } else if (latestDate === null) {
      break; // no generated reports found
    } else if (today.diff(latestDate).as('days') > lookbackDays) {
      break; // exceeded lookback window
    }
  }

  return reports;
}

class CSVExtractor extends CSVExtractorBase {
  constructor(opts) {
    super(opts);
    this.csvFound = false;
    this.summaryFound = false;
  }

  _transform(chunk, enc, done) {
    if (this.csvFound) {
      const line = chunk.toString();
      if (line.length === 0 || line[0] === ',') {
        // reached summary lines
        this.summaryFound = true;
        this.csvFound = false;
      } else {
        const convertedLine = convertDate(line);
        this.pushLine(convertedLine);
      }
    } else if (this.summaryFound) {
      this.push(null);
    } else {
      this.csvFound = true;
      const names = chunk.toString().split(',');
      return this.handleFields(names).then(done);
    }
    return done();
  }
}

module.exports = {
  getClient,
  getReportName,
  getReports,
  CSVExtractor,
};
