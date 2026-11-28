import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { SHARE_PERIOD_DAYS } from '../share-expiry.service';

export class ShareExpiryIdDto {
  @IsString()
  @IsNotEmpty()
  shareId: string;
}

export class SetShareExpiryDto extends ShareExpiryIdDto {
  // null removes the expiry; anything else must be one of the allowed periods
  @ValidateIf((_, value) => value !== null)
  @IsIn(SHARE_PERIOD_DAYS)
  periodDays: 1 | 7 | 30 | null;
}
