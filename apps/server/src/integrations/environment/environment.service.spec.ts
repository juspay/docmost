import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EnvironmentService } from './environment.service';
import { EnvironmentVariables } from './environment.validation';

function createService(env: Record<string, string>) {
  return new EnvironmentService(new ConfigService(env));
}

describe('EnvironmentService', () => {
  describe('getPageHistoryInterval', () => {
    it('defaults to five minutes', () => {
      expect(createService({}).getPageHistoryInterval()).toBe(5 * 60 * 1000);
    });

    it('reads a duration', () => {
      expect(
        createService({ PAGE_HISTORY_INTERVAL: '2m' }).getPageHistoryInterval(),
      ).toBe(2 * 60 * 1000);
    });

    it('never goes below one minute', () => {
      expect(
        createService({
          PAGE_HISTORY_INTERVAL: '10s',
        }).getPageHistoryInterval(),
      ).toBe(60 * 1000);
    });

    it('falls back to five minutes for an empty or unreadable value', () => {
      expect(
        createService({ PAGE_HISTORY_INTERVAL: '' }).getPageHistoryInterval(),
      ).toBe(5 * 60 * 1000);
      expect(
        createService({
          PAGE_HISTORY_INTERVAL: 'soon',
        }).getPageHistoryInterval(),
      ).toBe(5 * 60 * 1000);
    });
  });

  describe('isCollabEmbedded', () => {
    it('is true when COLLAB_URL is not set: browsers sync with this process', () => {
      expect(createService({}).isCollabEmbedded()).toBe(true);
      expect(createService({ COLLAB_URL: '  ' }).isCollabEmbedded()).toBe(true);
    });

    it('is false when COLLAB_URL is set: browsers sync with another server', () => {
      expect(
        createService({
          COLLAB_URL: 'https://collab.example.com',
        }).isCollabEmbedded(),
      ).toBe(false);
    });
  });

  describe('COLLAB_EXTERNAL', () => {
    it('says the sync server is separate, whatever COLLAB_URL says', () => {
      expect(
        createService({ COLLAB_EXTERNAL: 'true' }).isCollabEmbedded(),
      ).toBe(false);
      expect(
        createService({
          COLLAB_EXTERNAL: 'false',
          COLLAB_URL: 'https://wiki.example.com',
        }).isCollabEmbedded(),
      ).toBe(true);
      expect(
        createService({ COLLAB_EXTERNAL: 'TRUE' }).isCollabExternal(),
      ).toBe(true);
    });

    it('defaults to whether COLLAB_URL is set', () => {
      expect(createService({}).isCollabExternal()).toBe(false);
      expect(
        createService({
          COLLAB_URL: 'https://collab.example.com',
        }).isCollabExternal(),
      ).toBe(true);
      expect(
        createService({
          COLLAB_EXTERNAL: '',
          COLLAB_URL: 'https://collab.example.com',
        }).isCollabExternal(),
      ).toBe(true);
    });
  });

  describe('getCollabMessageSizeLimit', () => {
    it('defaults to 100 MiB, the limit before this setting existed', () => {
      expect(createService({}).getCollabMessageSizeLimit()).toBe(
        100 * 1024 * 1024,
      );
    });

    it('reads a size', () => {
      expect(
        createService({
          COLLAB_MESSAGE_SIZE_LIMIT: '32mb',
        }).getCollabMessageSizeLimit(),
      ).toBe(32 * 1024 * 1024);
    });

    it('never goes below 1 MiB', () => {
      expect(
        createService({
          COLLAB_MESSAGE_SIZE_LIMIT: '10kb',
        }).getCollabMessageSizeLimit(),
      ).toBe(1024 * 1024);
    });

    it('stays below 2 GiB, where ws would read the limit as none', () => {
      for (const value of ['2gb', '4gb', '100gb']) {
        const limit = createService({
          COLLAB_MESSAGE_SIZE_LIMIT: value,
        }).getCollabMessageSizeLimit();
        expect(limit).toBe(2 ** 31 - 1);
        // ws keeps maxPayload | 0 and enforces it only when positive
        expect(limit | 0).toBeGreaterThan(0);
      }
    });

    it('warns once with both values when it clamps the limit', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        createService({
          COLLAB_MESSAGE_SIZE_LIMIT: '4gb',
        }).getCollabMessageSizeLimit();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('4gb');
        expect(warn.mock.calls[0][0]).toContain('4294967296');
        expect(warn.mock.calls[0][0]).toContain('2147483647');

        warn.mockClear();
        createService({
          COLLAB_MESSAGE_SIZE_LIMIT: '32mb',
        }).getCollabMessageSizeLimit();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('falls back to 100 MiB for an unreadable value', () => {
      expect(
        createService({
          COLLAB_MESSAGE_SIZE_LIMIT: 'lots',
        }).getCollabMessageSizeLimit(),
      ).toBe(100 * 1024 * 1024);
    });
  });

  it('returns a configured value', () => {
    const service = createService({ FILE_UPLOAD_SIZE_LIMIT: '10mb' });
    expect(service.getFileUploadSizeLimit()).toBe('10mb');
  });

  it('falls back to the default when a value is unset', () => {
    expect(createService({}).getFileUploadSizeLimit()).toBe('50mb');
  });

  it('falls back to the default when a value is blank', () => {
    const service = createService({
      FILE_UPLOAD_SIZE_LIMIT: '',
      JWT_TOKEN_EXPIRES_IN: '',
    });
    expect(service.getFileUploadSizeLimit()).toBe('50mb');
    expect(service.getJwtTokenExpiresIn()).toBe('90d');
  });

  it('treats a blank value without a default as unset', () => {
    expect(createService({ DRAWIO_URL: '' }).getDrawioUrl()).toBeUndefined();
  });
});

describe('COLLAB_MESSAGE_SIZE_LIMIT validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    APP_SECRET: 'x'.repeat(32),
  };
  const errorsFor = (value?: string) =>
    validateSync(
      plainToInstance(EnvironmentVariables, {
        ...base,
        COLLAB_MESSAGE_SIZE_LIMIT: value,
      }),
    ).map((e) => e.property);

  it('accepts a size, a blank value and no value', () => {
    expect(errorsFor('16mb')).toEqual([]);
    expect(errorsFor('1048576')).toEqual([]);
    expect(errorsFor('')).toEqual([]);
    expect(errorsFor(undefined)).toEqual([]);
  });

  it('refuses a value that is not a size', () => {
    expect(errorsFor('lots')).toEqual(['COLLAB_MESSAGE_SIZE_LIMIT']);
    expect(errorsFor('-5mb')).toEqual(['COLLAB_MESSAGE_SIZE_LIMIT']);
  });
});

describe('COLLAB_EXTERNAL validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    APP_SECRET: 'x'.repeat(32),
  };
  const errorsFor = (value?: string) =>
    validateSync(
      plainToInstance(EnvironmentVariables, {
        ...base,
        COLLAB_EXTERNAL: value,
      }),
    ).map((e) => e.property);

  it('accepts true, false, blank and no value', () => {
    for (const v of ['true', 'false', 'TRUE', '', undefined]) {
      expect(errorsFor(v)).toEqual([]);
    }
  });

  it('refuses anything else', () => {
    expect(errorsFor('yes')).toEqual(['COLLAB_EXTERNAL']);
  });
});
