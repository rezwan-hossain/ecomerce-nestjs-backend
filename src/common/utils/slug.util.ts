import { randomUUID } from 'crypto';

function createSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with hyphens
    .replace(/^-+|-+$/g, ''); // Remove leading and trailing hyphens
}

function generateSlugWithUUID(text: string): string {
  const slug = createSlug(text);

  const uuidFrament = randomUUID()
    .replace(/-/g, '') // Remove hyphens from the UUID
    .slice(0, 4); // Take the first 4 characters for brevity

  return `${slug}-${uuidFrament}`;
}

export { createSlug, generateSlugWithUUID };
