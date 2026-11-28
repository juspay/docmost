import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import type { LiveBlockKind } from '@docmost/live-blocks';

const lowerCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

export class EnsureLiveBlockDto {
  @Transform(lowerCase)
  @IsUUID()
  blockId: string;

  @Transform(lowerCase)
  @IsUUID()
  pageId: string;

  // checked against the registered kinds by the service (400)
  @IsString()
  @IsNotEmpty()
  kind: LiveBlockKind;
}

export class CloneLiveBlockDto {
  @Transform(lowerCase)
  @IsUUID()
  sourceBlockId: string;

  @Transform(lowerCase)
  @IsUUID()
  blockId: string;

  @Transform(lowerCase)
  @IsUUID()
  pageId: string;
}

export class LiveBlockSnapshotDto {
  @Transform(lowerCase)
  @IsUUID()
  blockId: string;

  @Transform(lowerCase)
  @IsUUID()
  pageId: string;
}

export class SharedLiveBlockDto {
  @IsString()
  @IsOptional()
  shareId?: string;

  // a page id or slug, as the other public share routes take
  @IsString()
  @IsNotEmpty()
  pageId: string;

  @Transform(lowerCase)
  @IsUUID()
  blockId: string;
}
