import type {
  CreateCommentInput,
  CreateLiveBlockInput,
  CreatePageInput,
  CreateShareInput,
  CreateSpaceInput,
  ImportWriterPort,
  SpaceRoleName,
  GrantableRole,
  MapEntry,
} from '../import-writer';
import type { Page } from '@docmost/db/types/entity.types';
import type { RecordingWriter } from '../recording-writer';

export type WriteCall =
  | { op: 'space'; input: CreateSpaceInput }
  | { op: 'member'; input: { spaceId: string; userId: string } }
  | { op: 'page'; input: CreatePageInput }
  | { op: 'block'; input: CreateLiveBlockInput }
  | { op: 'comment'; input: CreateCommentInput }
  | { op: 'share'; input: CreateShareInput }
  | { op: 'content'; input: { page: Page } };

/** A RecordingWriter that throws on the calls `fails` picks, as a broken row would. */
export class FailingWriter implements ImportWriterPort {
  failures = 0;

  constructor(
    readonly inner: RecordingWriter,
    readonly fails: (call: WriteCall) => boolean,
  ) {}

  private check(call: WriteCall) {
    if (this.fails(call)) {
      this.failures++;
      throw new Error(`injected failure on ${call.op}`);
    }
  }

  inTransaction<T>(fn: (writer: ImportWriterPort) => Promise<T>): Promise<T> {
    return this.inner.inTransaction(() => fn(this));
  }
  createSpace(input: CreateSpaceInput) {
    this.check({ op: 'space', input });
    return this.inner.createSpace(input);
  }
  addSpaceMember(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ) {
    this.check({ op: 'member', input: { spaceId, userId } });
    return this.inner.addSpaceMember(spaceId, userId, role, map);
  }
  grantSpaceRole(
    spaceId: string,
    userId: string,
    role: GrantableRole,
    map?: MapEntry,
  ) {
    this.check({ op: 'member', input: { spaceId, userId } });
    return this.inner.grantSpaceRole(spaceId, userId, role, map);
  }
  setSpaceRole(
    spaceId: string,
    userId: string,
    role: SpaceRoleName,
    map?: MapEntry,
  ) {
    this.check({ op: 'member', input: { spaceId, userId } });
    return this.inner.setSpaceRole(spaceId, userId, role, map);
  }
  createPage(input: CreatePageInput) {
    this.check({ op: 'page', input });
    return this.inner.createPage(input);
  }
  createLiveBlock(input: CreateLiveBlockInput) {
    this.check({ op: 'block', input });
    return this.inner.createLiveBlock(input);
  }
  createComment(input: CreateCommentInput) {
    this.check({ op: 'comment', input });
    return this.inner.createComment(input);
  }
  createShare(input: CreateShareInput) {
    this.check({ op: 'share', input });
    return this.inner.createShare(input);
  }
  setPageContent(page: Page, content: unknown) {
    this.check({ op: 'content', input: { page } });
    return this.inner.setPageContent(page, content);
  }
}
