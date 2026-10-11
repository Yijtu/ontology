// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isLatestHumanReviewApproval, latestCandidateHeads } from '../../apps/web/src/api/ontology.js'
import type { HumanReviewView } from '../../apps/web/src/api/ontology.js'

const candidateId = '11111111-1111-4111-8111-111111111111'
const digest = `sha256:${'a'.repeat(64)}`

describe('current-content human approval', () => {
  it('does not treat an earlier approval as current after a same-content rejection', () => {
    const reviews: readonly HumanReviewView[] = [
      { candidateId, revision: '1', contentDigest: digest, decision: 'approve', reason: 'checked' },
      { candidateId, revision: '2', contentDigest: digest, decision: 'reject', reason: 'review changed' },
    ]
    expect(isLatestHumanReviewApproval(reviews, digest)).toBe(false)
  })

  it('requires the latest approval to pin the exact current content', () => {
    const reviews: readonly HumanReviewView[] = [
      { candidateId, revision: '1', contentDigest: digest, decision: 'approve', reason: 'checked' },
      { candidateId, revision: '2', contentDigest: `sha256:${'b'.repeat(64)}`, decision: 'approve', reason: 'new content' },
    ]
    expect(isLatestHumanReviewApproval(reviews, digest)).toBe(false)
    expect(isLatestHumanReviewApproval(reviews, `sha256:${'b'.repeat(64)}`)).toBe(true)
  })

  it('does not revive an approved candidate when a pending or rejected replacement becomes the current head', () => {
    for (const replacementState of ['pending', 'rejected']) {
      const current = latestCandidateHeads([
        { candidateId: 'approved-old', approved: true },
        { candidateId: 'replacement', replacesCandidateId: 'approved-old', approved: false, state: replacementState },
      ])
      expect(current.map((candidate) => candidate.candidateId)).toEqual(['replacement'])
      expect(current.filter((candidate) => candidate.approved)).toEqual([])
    }
  })
})
