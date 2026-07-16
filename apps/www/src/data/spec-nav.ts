// Sidebar navigation for /spec/*. Generated at module-load time from the
// spec content collection so adding a new spec file (with the required
// frontmatter) automatically adds a sidebar entry.

import { getCollection } from 'astro:content';

export interface SpecNavItem {
	id: string;
	label: string;
	order: number;
	description: string;
}

export async function getSpecNav(): Promise<SpecNavItem[]> {
	const entries = await getCollection('spec');
	// 00-overview is rendered on /spec/ itself (as "Overview") — exclude it
	// from the sidebar list and landing-page card grid to avoid duplication.
	return entries
		.filter((e) => e.id !== '00-overview')
		.map((e) => ({
			id: e.id,
			label: e.data.title,
			order: e.data.order,
			description: e.data.description,
		}))
		.sort((a, b) => a.order - b.order);
}

export async function findSpecTitle(id: string): Promise<string> {
	const nav = await getSpecNav();
	return nav.find((i) => i.id === id)?.label ?? id;
}
