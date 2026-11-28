import { Global, Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QueueName } from '../integrations/queue/constants';

/** Stands in for a BullMQ queue. An import must never add a job. */
export class RefusingQueue {
  readonly added: unknown[] = [];

  constructor(readonly name: string) {}

  async add(...args: unknown[]): Promise<never> {
    this.added.push(args);
    throw new Error(
      `The mindspace import must not add queue jobs (queue ${this.name})`,
    );
  }

  async addBulk(...args: unknown[]): Promise<never> {
    return this.add(...args);
  }
}

/**
 * What DatabaseModule's providers need injected, without Redis, BullMQ or event
 * listeners: the repositories ask for EventEmitter2 and the cache, and
 * PageListener asks for two queues. A bare EventEmitter2 has no @OnEvent
 * handlers attached, because EventEmitterModule is not loaded.
 */
@Global()
@Module({
  imports: [CacheModule.register({ isGlobal: true })],
  providers: [
    { provide: EventEmitter2, useValue: new EventEmitter2() },
    ...Object.values(QueueName).map((name) => ({
      provide: getQueueToken(name),
      useValue: new RefusingQueue(name),
    })),
  ],
  exports: [
    EventEmitter2,
    ...Object.values(QueueName).map((name) => getQueueToken(name)),
  ],
})
export class ImportInfraModule {}
