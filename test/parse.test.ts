import { expect, test } from 'vitest';
import { coversEpisode, episodeOf, isDiscOrRemux, pickFile, resolution, seasonInfo, showName } from '../src/parse';

test('resolution', () => {
  expect(resolution('Haborer.S02.1080p.WEB-DL.H.264-HBRW')).toBe(1080);
  expect(resolution('Reacher.S04.2160p.AMZN.WEB-DL')).toBe(2160);
  expect(resolution('Movie.2020.UHD.BluRay.x265')).toBe(2160);
  expect(resolution('Haborer.S04.720p.HDTV.x264-iLM')).toBe(720);
  expect(resolution('Galis.Complete.WS.PDTV-TVNETIL')).toBe(480);
  expect(resolution('Haborer.S01-S04.XviD-iLM')).toBe(480);
  expect(resolution('Some.Show')).toBe(0);
});

test('isDiscOrRemux', () => {
  expect(isDiscOrRemux('Gandhi.1982.2160p.UHD.BluRay.REMUX.HDR.HEVC')).toBe(true);
  expect(isDiscOrRemux('Inception.2010.2160p.UHD.Blu-ray.HEVC.DTS-HD.MA.5.1.TAiCHi')).toBe(true);
  expect(isDiscOrRemux('Game.Of.Thrones.S08.COMPLETE.UHD.BLURAY-MIXED')).toBe(true);
  expect(isDiscOrRemux('Game.of.Thrones.S01.2160p.UHD.BluRay.HDR.HEVC.Atmos-HDBEE')).toBe(true);
  expect(isDiscOrRemux('Reacher.S04.2160p.AMZN.WEB-DL.DDP5.1.DV.HDR.HEVC-NTb')).toBe(false);
  expect(isDiscOrRemux('Inception.2010.1080p.BluRay.DD+5.1.x264-playHD')).toBe(false);
  expect(isDiscOrRemux('Inception.2010.REPACK.2160p.UHD.BluRay.DTS-MA.5.1.HDR.x265-BlzT')).toBe(false);
  expect(isDiscOrRemux('Tequila.Sunrise.1988.BluRay.1080p.DTS-HD.MA.5.1.AVC.x264')).toBe(false);
});

test('seasonInfo', () => {
  expect(seasonInfo('Haborer.S04E12.720p.HDTV.x264-iLM')).toEqual({ kind: 'episode', season: 4, episode: 12 });
  expect(seasonInfo('Haborer.S02.1080p.WEB-DL')).toEqual({ kind: 'season', from: 2, to: 2 });
  expect(seasonInfo('Haborer.S01-S04.XviD-iLM')).toEqual({ kind: 'season', from: 1, to: 4 });
  expect(seasonInfo('Ninjago.Masters.of.Spinjitzu.S01-09.1080p')).toEqual({ kind: 'season', from: 1, to: 9 });
  expect(seasonInfo('Galis.Complete.WS.PDTV-TVNETIL')).toEqual({ kind: 'complete' });
  expect(seasonInfo('The.Lion.Guard.COMPLETE.1080p')).toEqual({ kind: 'complete' });
  expect(seasonInfo('Inception.2010.1080p.BluRay')).toBe(null);
});

test('coversEpisode', () => {
  expect(coversEpisode({ kind: 'episode', season: 4, episode: 12 }, 4, 12)).toBe(true);
  expect(coversEpisode({ kind: 'episode', season: 4, episode: 12 }, 4, 11)).toBe(false);
  expect(coversEpisode({ kind: 'season', from: 1, to: 4 }, 3, 1)).toBe(true);
  expect(coversEpisode({ kind: 'season', from: 2, to: 2 }, 3, 1)).toBe(false);
  expect(coversEpisode({ kind: 'complete' }, 7, 3)).toBe(true);
  expect(coversEpisode(null, 1, 1)).toBe(false);
});

const f = (path: string, length: number) => ({ path, length });

test('pickFile: movie takes largest video, ignores samples', () => {
  const files = [f('M/sample.mkv', 50e6), f('M/Movie.mkv', 8e9), f('M/Movie.nfo', 1e3), f('M/extras.mp4', 9e9 - 1)];
  expect(pickFile(files, null)?.path).toBe('M/extras.mp4');
  const files2 = [f('M/Movie.Sample.mkv', 60e6), f('M/Movie.mkv', 8e9)];
  expect(pickFile(files2, null)?.path).toBe('M/Movie.mkv');
});

test('pickFile: episode from a pack', () => {
  const files = [
    f('Show.S02/Show.S02E01.1080p.mkv', 2e9),
    f('Show.S02/Show.S02E10.1080p.mkv', 2e9),
    f('Show.S02/Show.S02E01.1080p.srt', 1e5),
  ];
  expect(pickFile(files, { season: 2, episode: 1 })?.path).toBe('Show.S02/Show.S02E01.1080p.mkv');
  expect(pickFile(files, { season: 2, episode: 10 })?.path).toBe('Show.S02/Show.S02E10.1080p.mkv');
  expect(pickFile(files, { season: 2, episode: 3 })).toBe(null);
  expect(pickFile(files, { season: 1, episode: 1 })).toBe(null);
});

test('pickFile: multi-season pack with season folders and 1x02 naming', () => {
  const files = [f('Pack/Season 1/Show 1x02.avi', 7e8), f('Pack/Season 2/Show 2x02.avi', 7e8), f('Pack/Season 2/Show 2x12.avi', 7e8)];
  expect(pickFile(files, { season: 2, episode: 2 })?.path).toBe('Pack/Season 2/Show 2x02.avi');
  expect(pickFile(files, { season: 1, episode: 2 })?.path).toBe('Pack/Season 1/Show 1x02.avi');
});

test('pickFile: single-episode torrent', () => {
  const files = [f('Haborer.S04E12.720p.HDTV.x264-iLM.mkv', 9e8)];
  expect(pickFile(files, { season: 4, episode: 12 })?.path).toBe(files[0]?.path);
});

test('pickFile: episode-only names inside a season folder', () => {
  const files = [f('Galis/Season 3/Galis - E05.avi', 3e8), f('Galis/Season 2/Galis - E05.avi', 3e8)];
  expect(pickFile(files, { season: 3, episode: 5 })?.path).toBe('Galis/Season 3/Galis - E05.avi');
});

test('episodeOf', () => {
  expect(episodeOf('Galis.Complete/Galis.S03.WS.PDTV/Galis.S03E13.WS.PDTV.XviD-So_Up.avi')).toEqual({
    season: 3,
    episode: 13,
  });
  expect(episodeOf('GoT.S01-S05/GoT.S01.720p/game.of.thrones.s01e02.720p.mkv')).toEqual({ season: 1, episode: 2 });
  expect(episodeOf('Pack/Season 2/Show 2x12.avi')).toEqual({ season: 2, episode: 12 });
  expect(episodeOf('Galis/עונה 4/גאליס פרק 7.avi')).toEqual({ season: 4, episode: 7 });
  expect(episodeOf('Movie.2010.1080p/Movie.2010.1080p.x264.mkv')).toBe(null);
  expect(episodeOf('Show.S01/Show.S01.Extras.mkv')).toBe(null);
  expect(episodeOf('Film.1920x1080.mkv')).toBe(null);
});

test('showName', () => {
  expect(showName('Game.of.Thrones.S01-S05.720p.HDTV.x264-Hebits')).toBe('Game of Thrones');
  expect(showName('Galis.Complete.WS.PDTV-TVNETIL')).toBe('Galis');
  expect(showName('IT.Welcome.to.Derry.S01.2160p.HMAX.WEB-DL')).toBe('IT Welcome to Derry');
  expect(showName('Inception.2010.1080p.BluRay.x264')).toBe('Inception');
  expect(showName('Black.Sails.COMPLETE.720p.BluRay')).toBe('Black Sails');
});
