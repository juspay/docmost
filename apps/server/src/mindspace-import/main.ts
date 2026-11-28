import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import * as readline from 'node:readline/promises';
import { ArgsError, USAGE, parseArgs } from './args';
import { MindspaceImportModule } from './mindspace-import.module';
import {
  ImportRefused,
  MindspaceImportService,
  type ImportIo,
} from './mindspace-import.service';
import { ALL_STEPS } from './steps';
import { verifyImport } from './verify';

const io: ImportIo = {
  log: (line) => console.log(line),
  ask: async (question) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

async function main(): Promise<number> {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgsError) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }

  const app = await NestFactory.createApplicationContext(
    MindspaceImportModule,
    {
      logger: ['error', 'warn'],
    },
  );
  try {
    const { exitCode } = await app
      .get(MindspaceImportService)
      .run(options, io, { steps: ALL_STEPS, verify: verifyImport });
    return exitCode;
  } catch (err) {
    if (err instanceof ImportRefused) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
