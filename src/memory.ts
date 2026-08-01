import {
  ALLOWED_ANNOTATION_TYPES,
  AnnotationType,
  CATEGORY_KEYWORDS,
  CATEGORY_QUERIES,
  DEFAULT_SEARCH_LIMIT,
  FULL_TEXT_SCORE,
  MemoryCategory,
  SIMILARITY_THRESHOLD,
  SyncFailure,
  err,
  ok,
  type Result,
} from './core.ts'
import type { McpClient } from './mcp.ts'
import { redact } from './redact.ts'

export type MemoryEntry = {
  readonly category: MemoryCategory
  readonly title: string
  readonly createdAt: string
  readonly text: string
}

export type CollectOptions = {
  readonly project: string
  readonly aliases: ReadonlyArray<string>
  readonly since: Date
  readonly deniedTerms: ReadonlyArray<string>
}

const foldForMatching = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

export const isAboutProject = (sessionTitle: string, terms: ReadonlyArray<string>): boolean => {
  const folded = foldForMatching(sessionTitle)

  return terms.some((term) => {
    const foldedTerm = foldForMatching(term)
    return foldedTerm.length > 0 && folded.includes(foldedTerm)
  })
}

type ScoredCategory = { readonly category: MemoryCategory; readonly score: number }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

const readSearchIdentifiers = (payload: unknown): ReadonlyArray<ScoredCategory & { id: string }> => {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return []

  const found: Array<ScoredCategory & { id: string }> = []
  for (const entry of payload.results) {
    if (!isRecord(entry)) continue
    const id = readString(entry, 'identifier')
    const score = typeof entry.score === 'number' ? entry.score : 0
    if (id) found.push({ id, score, category: MemoryCategory.ArchitectureDecisions })
  }
  return found
}

const readItems = (payload: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return []
  return payload.items.filter(isRecord)
}

const readCreatedAt = (summary: Record<string, unknown>): string | null => {
  const created = summary.created
  if (!isRecord(created)) return null
  return readString(created, 'value')
}

const readAnnotationIds = (summary: Record<string, unknown>): ReadonlyArray<string> => {
  const annotations = summary.annotations
  if (!isRecord(annotations)) return []
  const indices = annotations.indices
  if (!isRecord(indices)) return []
  return Object.keys(indices)
}

const readFullTextIdentifiers = (payload: unknown): ReadonlyArray<string> => {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return []

  const found: string[] = []
  for (const entry of payload.results) {
    if (!isRecord(entry)) continue
    const summary = entry.summary
    if (!isRecord(summary)) continue
    const id = readString(summary, 'id')
    if (id) found.push(id)
  }
  return found
}

const searchCategory = async (
  client: McpClient,
  category: MemoryCategory,
  project: string,
): Promise<Result<ReadonlyArray<ScoredCategory & { id: string }>, SyncFailure>> => {
  const semantic = await client.callTool('workstream_summaries_vector_search', {
    query: `${CATEGORY_QUERIES[category]} in the project ${project}`,
    limit: DEFAULT_SEARCH_LIMIT,
    threshold: SIMILARITY_THRESHOLD,
  })
  if (!semantic.ok) return semantic

  const keyword = await client.callTool('workstream_summaries_full_text_search', {
    query: `${project} ${CATEGORY_KEYWORDS[category]}`,
    limit: DEFAULT_SEARCH_LIMIT,
  })
  if (!keyword.ok) return keyword

  const hits = [
    ...readSearchIdentifiers(semantic.value).map((entry) => ({ ...entry, category })),
    ...readFullTextIdentifiers(keyword.value).map((id) => ({
      id,
      score: FULL_TEXT_SCORE,
      category,
    })),
  ]

  return ok(hits)
}

export const collectMemories = async (
  client: McpClient,
  options: CollectOptions,
): Promise<Result<ReadonlyArray<MemoryEntry>, SyncFailure>> => {
  const bestCategoryBySummary = new Map<string, ScoredCategory>()

  for (const category of Object.values(MemoryCategory)) {
    const search = await searchCategory(client, category, options.project)
    if (!search.ok) return search

    for (const hit of search.value) {
      const current = bestCategoryBySummary.get(hit.id)
      if (!current || hit.score > current.score) {
        bestCategoryBySummary.set(hit.id, { category: hit.category, score: hit.score })
      }
    }
  }

  if (bestCategoryBySummary.size === 0) return err(SyncFailure.NoMemoriesInWindow)

  const snapshot = await client.callTool('workstream_summaries_batch_snapshot', {
    identifiers: [...bestCategoryBySummary.keys()],
  })
  if (!snapshot.ok) return snapshot

  const summariesInWindow = readItems(snapshot.value).filter((summary) => {
    const createdAt = readCreatedAt(summary)
    if (!createdAt) return false
    return new Date(createdAt).getTime() >= options.since.getTime()
  })

  if (summariesInWindow.length === 0) return err(SyncFailure.NoMemoriesInWindow)

  const summaryByAnnotation = new Map<string, Record<string, unknown>>()
  for (const summary of summariesInWindow) {
    for (const annotationId of readAnnotationIds(summary)) {
      summaryByAnnotation.set(annotationId, summary)
    }
  }

  if (summaryByAnnotation.size === 0) return err(SyncFailure.NoMemoriesInWindow)

  const annotations = await client.callTool('annotations_batch_snapshot', {
    identifiers: [...summaryByAnnotation.keys()],
  })
  if (!annotations.ok) return annotations

  const bodyBySummaryId = new Map<string, { title: string; createdAt: string; text: string; category: MemoryCategory }>()

  for (const annotation of readItems(annotations.value)) {
    const annotationId = readString(annotation, 'id')
    const annotationType = readString(annotation, 'type')
    const text = readString(annotation, 'text')

    if (!annotationId || !annotationType || !text) continue
    if (!ALLOWED_ANNOTATION_TYPES.has(annotationType as AnnotationType)) continue

    const summary = summaryByAnnotation.get(annotationId)
    if (!summary) continue

    const summaryId = readString(summary, 'id')
    const createdAt = readCreatedAt(summary)
    if (!summaryId || !createdAt) continue

    const existing = bodyBySummaryId.get(summaryId)
    const isRicherBody = annotationType === AnnotationType.Summary
    if (existing && !isRicherBody) continue

    bodyBySummaryId.set(summaryId, {
      title: readString(summary, 'name') ?? 'Untitled session',
      createdAt,
      text: redact(text, options.deniedTerms),
      category: bestCategoryBySummary.get(summaryId)?.category ?? MemoryCategory.ArchitectureDecisions,
    })
  }

  const projectTerms = [options.project, ...options.aliases]
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0)

  const entries = [...bodyBySummaryId.values()]
    .filter((body) => isAboutProject(body.title, projectTerms))
    .map(
      (body): MemoryEntry => ({
        category: body.category,
        title: body.title,
        createdAt: body.createdAt,
        text: body.text,
      }),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  if (entries.length === 0) return err(SyncFailure.NoProjectMatch)

  return ok(entries)
}
