import { SetMetadata } from '@nestjs/common';

export const MODULE_KEY_METADATA = 'required_module';
export const RequireModule = (key: string) => SetMetadata(MODULE_KEY_METADATA, key);
