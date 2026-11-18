# Custom music

Drop audio files here and the engine uses them **before** Instagram's catalogue,
on both platforms, exactly as supplied. One folder per mood:

```
custom/heartbreak/    slowed, reverb, sad — quiet hurt
custom/growth/        anthemic, cinematic — rising up
custom/motivation/    rap, hard beats — hard truth, cocky lines
custom/               used by every mood when its mood folder is empty
```

Accepted extensions: `mp3`, `m4a`, `aac`, `wav`, `ogg`, `flac`.

- Files are rotated least-recently-used, so every song plays before any repeats.
- No native attach happens with these files: the same file is muxed into the
  render, which is what YouTube and Instagram both play.
- The caption credit is the file name, cleaned up: `bye (slowed).mp3` becomes
  `Music: bye slowed`.
- **Commit the file** if the GitHub Actions run should use it too. Custom tracks
  are not downloaded from anywhere at run time.

Only add audio you have the right to use. Content ID on YouTube can claim or
mute a Short that carries a commercial recording.
