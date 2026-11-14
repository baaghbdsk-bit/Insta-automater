'use strict';

/**
 * Content themes. Each theme maps to:
 *  - music:  which royalty-free pool to draw a track from
 *  - queries: image search terms (broad on purpose; narrow queries return nothing)
 *  - tone:   guidance handed to the generator
 *
 * Adding a theme here is enough for the engine to start using it.
 */
const THEMES = {
  heartbreak: {
    music: 'heartbreak',
    tone: 'loss of love, the ache of someone leaving, missing a person',
    queries: ['rain window', 'sad', 'alone', 'night street', 'empty bench'],
  },
  loneliness: {
    music: 'heartbreak',
    tone: 'being alone, silence, nights spent by yourself, feeling unseen',
    queries: ['lonely', 'fog', 'empty bench', 'night silhouette', 'alone'],
  },
  letting_go: {
    music: 'heartbreak',
    tone: 'moving on, accepting an ending, releasing what you cannot keep',
    queries: ['sunset', 'ocean', 'open road', 'sea horizon', 'evening sky'],
  },
  self_respect: {
    music: 'growth',
    tone: 'knowing your worth, walking away, refusing to be treated cheaply',
    queries: ['portrait back', 'mirror', 'standing alone', 'confident woman'],
  },
  growth: {
    music: 'growth',
    tone: 'becoming better slowly, small daily gains, compounding effort',
    queries: ['sunrise', 'mountain', 'staircase', 'forest path', 'plant growing'],
  },
  discipline: {
    music: 'growth',
    tone: 'doing it when nobody is watching, routine over mood, self control',
    queries: ['running', 'gym', 'staircase', 'dark room window', 'road fog'],
  },
  ambition: {
    music: 'growth',
    tone: 'wanting more, hunger for a bigger life, the cost of a dream',
    queries: ['city skyline', 'road ahead', 'climbing', 'desk night', 'night city'],
  },
  confidence: {
    music: 'motivation',
    tone: 'quiet self belief, no need to prove anything, owning your presence',
    queries: ['portrait silhouette', 'walking street', 'standing alone', 'man suit'],
  },
  success: {
    music: 'motivation',
    tone: 'what winning actually costs, patience, the lonely part of the climb',
    queries: ['summit', 'sunrise mountain', 'city lights', 'climbing'],
  },
  motivation: {
    music: 'motivation',
    tone: 'pushing through, refusing to quit, starting again after failure',
    queries: ['storm', 'cliff', 'ocean wave', 'thundercloud', 'desert road'],
  },
  life_lessons: {
    music: 'motivation',
    tone: 'hard truths learned late, hindsight, what experience teaches',
    queries: ['old man', 'path forest', 'hands', 'candle', 'bench park'],
  },
  reality: {
    music: 'motivation',
    tone: 'how people actually behave, money and respect, unromantic truths',
    queries: ['crowd street', 'train window', 'city rain', 'mirror'],
  },
  friendship: {
    music: 'growth',
    tone: 'who stays, who leaves, loyalty between friends',
    queries: ['friends sunset', 'two people silhouette', 'beach friends', 'walking together'],
  },
  emotional_intelligence: {
    music: 'growth',
    tone: 'reading people, staying calm, choosing your battles, empathy',
    queries: ['calm water', 'person thinking', 'zen', 'hands heart', 'quiet room'],
  },
};

const THEME_KEYS = Object.keys(THEMES);
const MUSIC_MOODS = ['heartbreak', 'growth', 'motivation'];

const VISUAL_VARIANTS = ['center', 'lower', 'upper'];

function themeFor(mood) {
  return THEME_KEYS.find((t) => THEMES[t].music === mood) || 'motivation';
}

module.exports = { THEMES, THEME_KEYS, MUSIC_MOODS, VISUAL_VARIANTS, themeFor };
