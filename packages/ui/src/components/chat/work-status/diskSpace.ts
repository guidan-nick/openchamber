import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const diskSpaceSchema = z.object({
  totalBytes: z.number().finite().positive(),
  availableBytes: z.number().finite().nonnegative(),
}).refine((value) => value.availableBytes <= value.totalBytes);

export type DiskSpace = z.infer<typeof diskSpaceSchema>;

export const readDiskSpace = async (directory: string, signal: AbortSignal): Promise<DiskSpace> => {
  const response = await runtimeFetch('/api/fs/disk-space', { query: { directory }, signal });
  if (!response.ok) throw new Error('Disk space request failed');
  return diskSpaceSchema.parse(await response.json());
};

export const formatDiskBytes = (bytes: number, locale: string): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** index)} ${units[index]}`;
};
