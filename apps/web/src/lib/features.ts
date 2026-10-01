import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * What the platform has switched on (Plan 29). Today that is only texting.
 *
 * Public, because sign-in and self check-in read it before anyone is signed in.
 * Until it answers, texting counts as off: an option that appears a moment late
 * is better than one offered and then refused.
 */
export function useFeatures(): { sms: boolean } {
  const { data } = useQuery({
    queryKey: ['public/features'],
    queryFn: () => api.public.features(),
    staleTime: Infinity,
    refetchOnWindowFocus: 'always',
  });
  return { sms: data?.sms ?? false };
}
