'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { candidatePreviewUrl, candidateThumbUrl } from '@/lib/api';
import type { JobCandidate } from '@/lib/types';
import { mmss } from '@/lib/format';

export function CandidateReview({
  jobId,
  candidates,
  selected,
  onSelect,
  hook,
  caption,
  hashtags,
  source,
  provider,
  faceFrac,
  transcriptVia,
}: {
  jobId: string;
  candidates: JobCandidate[];
  selected: number;
  onSelect: (index: number) => void;
  hook?: string;
  caption?: string;
  hashtags?: string[];
  source: { title: string; channel: string; url: string };
  provider?: 'youtube' | 'twitch' | null;
  faceFrac?: number | null;
  transcriptVia: 'youtube' | 'whisper' | null;
}) {
  const cur = candidates.find((c) => c.index === selected) ?? candidates[0];
  const [copied, setCopied] = useState(false);
  if (!cur) return null;
  const isPost = !source.url;

  const postText = [caption, (hashtags ?? []).map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(postText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div className="flex flex-col items-center">
      {hook && <p className="mb-4 max-w-[440px] text-center text-lg font-semibold tracking-tight">“{hook}”</p>}
      <div className="w-full max-w-[300px] overflow-hidden rounded-[var(--radius-lg)] bg-black shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_40px_-12px_rgba(0,0,0,0.22)]">
        <video
          key={cur.index}
          src={candidatePreviewUrl(jobId, cur.index)}
          controls
          autoPlay
          loop
          playsInline
          className="aspect-[9/16] w-full bg-black"
        />
      </div>

      <h2 className="mt-6 max-w-[440px] text-center text-[15px] font-medium text-[color:var(--color-muted)]">
        {cur.hookTitle}
      </h2>
      {cur.reason && (
        <p className="mt-1.5 max-w-[420px] text-center text-[13px] text-[color:var(--color-muted)]">{cur.reason}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] text-[color:var(--color-muted)]">
        {provider === 'twitch' && (
          <span className="rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-accent-hover)]">
            Twitch
          </span>
        )}
        <span>
          {isPost
            ? `${Math.round(cur.durationSec)}s · 1080×1920`
            : `${mmss(cur.segment[0])}–${mmss(cur.segment[1])} · ${Math.round(cur.durationSec)}s · ${
                cur.reframeMode === 'letterbox' ? 'letterboxed' : 'cropped'
              }`}
          {!isPost && source.channel ? ` · ${source.channel}` : ''}
        </span>
        {typeof faceFrac === 'number' && faceFrac > 0 && (
          <span title="how much of the clip shows a face-cam">
            · {faceFrac >= 0.5 ? 'face-cam' : `face-cam ${Math.round(faceFrac * 100)}%`}
          </span>
        )}
      </div>

      {postText && (
        <div className="mt-5 w-full max-w-[440px] rounded-[var(--radius)] border border-[color:var(--color-hairline)] p-3.5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] font-medium uppercase tracking-wide text-[color:var(--color-faint)]">
              Post copy
            </span>
            <button
              onClick={copy}
              className="text-[12px] font-medium text-[color:var(--color-accent)] hover:text-[color:var(--color-accent-hover)]"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {caption && <p className="text-[13px] leading-relaxed">{caption}</p>}
          {hashtags && hashtags.length > 0 && (
            <p className="mt-1.5 text-[13px] text-[color:var(--color-muted)]">
              {hashtags.map((t) => `#${t}`).join(' ')}
            </p>
          )}
        </div>
      )}

      {candidates.length > 1 && (
        <div className="mt-7 w-full">
          <p className="mb-3 text-center text-[13px] text-[color:var(--color-muted)]">
            {candidates.length} moments ranked by the model — pick one
          </p>
          <div className="flex justify-center gap-3">
            {candidates.map((cand) => (
              <button
                key={cand.index}
                onClick={() => onSelect(cand.index)}
                className={clsx(
                  'group relative w-[84px] shrink-0 overflow-hidden rounded-[10px] border-2 transition',
                  cand.index === selected
                    ? 'border-[color:var(--color-accent)]'
                    : 'border-transparent opacity-70 hover:opacity-100',
                )}
              >
                <img src={candidateThumbUrl(jobId, cand.index)} alt="" className="aspect-[9/16] w-full bg-black object-cover" />
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-4 text-left">
                  <span className="block truncate text-[10px] font-medium leading-tight text-white">{cand.hookTitle}</span>
                </span>
                {cand.index === 0 && (
                  <span className="absolute left-1 top-1 rounded bg-[color:var(--color-accent)] px-1 py-0.5 text-[9px] font-semibold text-white">
                    top
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isPost && (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className="mt-5 max-w-[340px] truncate text-center text-[12px] text-[color:var(--color-muted)] underline decoration-[color:var(--color-hairline-strong)] underline-offset-2 hover:text-[color:var(--color-text)]"
        >
          {source.title} · captions via {transcriptVia === 'youtube' ? 'YouTube + Whisper' : 'Whisper'}
        </a>
      )}
    </div>
  );
}
