#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const COMMAND_ENV = 'CLOUDCLI_AUTOMATION_CLAUDE_COMMAND';
const ARGS_ENV = 'CLOUDCLI_AUTOMATION_CLAUDE_ARGS';
const ENV_SOCKET_ENV = 'CLOUDCLI_AUTOMATION_ENV_SOCKET';
const ENV_TOKEN_ENV = 'CLOUDCLI_AUTOMATION_ENV_TOKEN';
const MAX_ENVIRONMENT_PAYLOAD_BYTES = 4 * 1024 * 1024;
const ENVIRONMENT_TIMEOUT_MS = 5_000;
const INTERNAL_ENV_KEYS = [
  COMMAND_ENV,
  ARGS_ENV,
  'CLOUDCLI_AUTOMATION_NODE',
  'CLOUDCLI_AUTOMATION_LAUNCHER',
  ENV_SOCKET_ENV,
  ENV_TOKEN_ENV,
  'ELECTRON_RUN_AS_NODE',
];

function fail(message) {
  process.stderr.write(`[CloudCLI automation] ${message}\n`);
  process.exitCode = 1;
}

function requestEnvironment(socketPath, runtimeToken) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error, environment) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(environment);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(ENVIRONMENT_TIMEOUT_MS, () => {
      finish(new Error('the one-time environment socket timed out'));
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ type: 'request', runtime_token: runtimeToken })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_ENVIRONMENT_PAYLOAD_BYTES) {
        finish(new Error('the environment payload exceeded the protocol size limit'));
        return;
      }
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      let message;
      try {
        message = JSON.parse(buffer.slice(0, newlineIndex));
      } catch {
        finish(new Error('the environment payload was malformed JSON'));
        return;
      }
      const environment = message?.environment;
      const validEnvironment = environment
        && typeof environment === 'object'
        && !Array.isArray(environment)
        && Object.entries(environment).every(([key, value]) => (
          key.length > 0 && typeof value === 'string'
        ));
      if (message?.type !== 'environment' || message.runtime_token !== runtimeToken
        || !validEnvironment) {
        finish(new Error('the environment payload failed validation'));
        return;
      }
      socket.write(
        `${JSON.stringify({ type: 'ack', runtime_token: runtimeToken })}\n`,
        (error) => finish(error ?? null, environment),
      );
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('the environment socket closed before delivery'));
    });
  });
}

const command = process.env[COMMAND_ENV];
const encodedArgs = process.env[ARGS_ENV];
const environmentSocket = process.env[ENV_SOCKET_ENV];
const runtimeToken = process.env[ENV_TOKEN_ENV];

if (!command || !encodedArgs || !environmentSocket || !runtimeToken) {
  fail('The tmux launcher did not receive its command, arguments, and environment transport.');
} else {
  let args;
  try {
    args = JSON.parse(Buffer.from(encodedArgs, 'base64url').toString('utf8'));
  } catch {
    fail('The tmux launcher received an invalid Claude argument payload.');
  }

  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string')) {
    fail('The tmux launcher received Claude arguments in an invalid format.');
  } else {
    try {
      const environment = await requestEnvironment(environmentSocket, runtimeToken);
      for (const key of INTERNAL_ENV_KEYS) delete environment[key];

      const child = spawn(command, args, {
        env: environment,
        shell: false,
        stdio: 'inherit',
      });
      const forwardSignal = (signal) => {
        if (!child.killed) child.kill(signal);
      };
      process.once('SIGINT', () => forwardSignal('SIGINT'));
      process.once('SIGTERM', () => forwardSignal('SIGTERM'));
      child.once('error', (error) => {
        fail(`Unable to launch Claude Code: ${error.message}`);
      });
      child.once('exit', (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exitCode = code ?? 1;
      });
    } catch (error) {
      fail(`The tmux launcher could not receive its environment: ${error.message}`);
    }
  }
}
