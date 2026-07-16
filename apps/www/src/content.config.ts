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

export const collections = { spec };
