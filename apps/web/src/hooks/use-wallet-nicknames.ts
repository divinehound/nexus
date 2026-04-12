'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/auth-context';
import { getMyNicknames, setWalletNickname } from '@/lib/api';

const QUERY_KEY = ['wallet-nicknames'];

/** Fetch and cache all of the current user's wallet nicknames. */
export function useWalletNicknames() {
  const { accessToken } = useAuth();

  const { data: nicknames } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => getMyNicknames(accessToken!),
    enabled: !!accessToken,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return nicknames ?? {};
}

/** Save or delete a personal nickname for a wallet address. */
export function useSetNickname() {
  const { accessToken } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      address,
      nickname,
    }: {
      address: string;
      nickname: string | null;
    }) => setWalletNickname(address, nickname, accessToken!),
    onMutate: async ({ address, nickname }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: QUERY_KEY });
      const prev = queryClient.getQueryData<Record<string, string>>(QUERY_KEY);

      queryClient.setQueryData<Record<string, string>>(QUERY_KEY, (old) => {
        const next = { ...(old ?? {}) };
        if (!nickname || nickname.trim() === '') {
          delete next[address];
        } else {
          next[address] = nickname.trim();
        }
        return next;
      });

      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(QUERY_KEY, context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}
