import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateAccessTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsIn(['read', 'write'])
  scope: 'read' | 'write';

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;
}

export class RevokeAccessTokenDto {
  @IsUUID()
  id: string;
}
