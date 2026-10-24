// "To film" on Calendar: the days she picked with "Add to my Calendar" on a Get it sponsored video
// idea (routes/sponsored.ts film_plans). Not posts: nothing here ever posts. Tick it when filmed.
import { Link } from "react-router-dom";
import { get, post } from "../lib/api";
import { fmtDate } from "../lib/format";
import { useLoad, useToast } from "./ui";
import "../styles/sponsored.css";

interface FilmItem {
  id: string;
  day: string;
  title: string;
  note: string;
  askId: string | null;
  done: boolean;
}

export function ToFilm({ from, to }: { from: string; to: string }) {
  const toast = useToast();
  const { data, setData } = useLoad(() => get<{ items: FilmItem[] }>(`/api/sponsored/film?from=${from}&to=${to}`), [from, to]);
  if (!data?.items.length) return null;
  async function done(f: FilmItem, on: boolean) {
    setData((d) => (d ? { items: d.items.map((x) => (x.id === f.id ? { ...x, done: on } : x)) } : d));
    try {
      await post(`/api/sponsored/film/${f.id}/done`, { done: on });
    } catch (e) {
      toast.bad(e);
    }
  }
  return (
    <section className="section" aria-label="To film">
      <div className="section-head">
        <h2>To film</h2>
      </div>
      <ul className="film-plans">
        {data.items.map((f) => (
          <li key={f.id} className={f.done ? "done" : ""}>
            <span className="grow">
              <strong>
                {fmtDate(`${f.day}T12:00:00Z`, { weekday: "short", day: "numeric", month: "short" })}: {f.title}
              </strong>
              {f.note ? <span className="hint">{f.note.split("\n")[0]}</span> : null}
              {f.askId ? <Link to={`/deals/sponsored/${f.askId}`}>Open the idea</Link> : null}
            </span>
            <button type="button" className="btn small quiet" onClick={() => done(f, !f.done)}>
              {f.done ? "Not filmed yet" : "Filmed it"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
