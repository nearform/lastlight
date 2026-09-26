import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'zod';

const spec = defineCollection({
	loader: glob({ pattern: '*.md', base: './src/content/spec' }),
	schema: z.object({
		title: z.string(),
		order: z.number(),
		description: z.string(),
	}),
});

// Written by scripts/sync-releases.mjs from the GitHub Releases API — one file
// per `v*` release, the Release body as the markdown body.
const releases = defineCollection({
	loader: glob({ pattern: '*.md', base: './src/content/releases' }),
	schema: z.object({
		tag: z.string(),
		title: z.string(),
		date: z.coerce.date(),
		url: z.string().url(),
		prerelease: z.boolean(),
	}),
});

export const collections = { spec, releases };
