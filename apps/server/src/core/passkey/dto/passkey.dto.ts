import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class RegisterOptionsDto {
  @IsOptional()
  @IsString()
  currentPassword?: string;
}

export class RegisterVerifyDto {
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  @IsObject()
  response: Record<string, unknown>;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

export class LoginVerifyDto {
  @IsString()
  @IsNotEmpty()
  challengeId: string;

  @IsObject()
  response: Record<string, unknown>;
}

export class RenamePasskeyDto {
  @IsUUID()
  id: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;
}

export class DeletePasskeyDto {
  @IsUUID()
  id: string;
}

export class AdminDeletePasskeysDto {
  @IsUUID()
  userId: string;
}
