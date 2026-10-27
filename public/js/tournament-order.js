(function (root) {
    function tournamentStatus(tournament, now = Date.now()) {
        const total = Number(tournament.match_count) || 0;
        const finished = Number(tournament.finished_count) || 0;
        if (total > 0 && finished >= total) return 'finished';
        const start = Date.parse(tournament.begin_at);
        if (Number(tournament.ongoing_count) > 0 || (total > 0 && Number.isFinite(start) && start <= now)) return 'ongoing';
        return 'upcoming';
    }

    function sortTournaments(tournaments, now = Date.now()) {
        const rank = { ongoing: 0, upcoming: 1, finished: 2 };
        const timestamp = value => {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : null;
        };
        return [...tournaments].sort((a, b) => {
            const aStatus = tournamentStatus(a, now);
            const bStatus = tournamentStatus(b, now);
            if (aStatus !== bStatus) return rank[aStatus] - rank[bStatus];
            const aTime = timestamp(aStatus === 'finished' ? (a.end_at || a.begin_at || a.created_at) : (a.begin_at || a.created_at));
            const bTime = timestamp(bStatus === 'finished' ? (b.end_at || b.begin_at || b.created_at) : (b.begin_at || b.created_at));
            if (aTime === null || bTime === null) return aTime === bTime ? 0 : aTime === null ? 1 : -1;
            return aStatus === 'upcoming' ? aTime - bTime : bTime - aTime;
        });
    }

    const api = { tournamentStatus, sortTournaments };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.tournamentOrder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
