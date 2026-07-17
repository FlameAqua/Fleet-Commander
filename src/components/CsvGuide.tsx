import { useState } from 'react'
import { createPortal } from 'react-dom'
import { openExternal } from '../lib/external'
import './csvGuide.css'

/** A small "How do I make CSVs?" link that opens a brief themed guide. */
export function CsvGuide() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="csvguide__link" onClick={() => setOpen(true)}>
        How do I make CSVs?
      </button>
      {open &&
        createPortal(
          <div className="csvguide__overlay" onMouseDown={() => setOpen(false)}>
            <div className="csvguide" onMouseDown={(e) => e.stopPropagation()}>
              <div className="csvguide__head">
                <h3>How do I make a CSV?</h3>
                <button type="button" className="csvguide__close" onClick={() => setOpen(false)}>
                  ✕
                </button>
              </div>
              <p className="csvguide__intro">
                A CSV (comma-separated value) file contains a header row, then value rows per system. At a
                minimum it needs a <b>host/URL</b> column and a <b>Password</b> column. See below:
              </p>
              <pre className="csvguide__code">{`Account,Login Name,Password,Web Site,Comments
Edge-01,root,hunter2,ssh://root@10.0.0.5,Main site
Edge-02,root,s3cret,ssh://root@10.0.0.6,`}</pre>
              <p>
                Each value separated by commas corresponds to the above title in the same order.
                To see more, go to the{' '}
                <a
                  href="https://en.wikipedia.org/wiki/Comma-separated_values"
                  onClick={(e) => {
                    e.preventDefault()
                    openExternal('https://en.wikipedia.org/wiki/Comma-separated_values')
                  }}
                >
                  Wikipedia page
                </a>
                .
              </p>
              
              <h4 className="csvguide__rec">
                Export from KeePass <span className="csvguide__recbadge">Recommended</span>
              </h4>
              <ol>
                <li>Open your KeePass database to export.</li>
                <li>
                  <b>File → Export → KeePass CSV</b> (double-click) <b>→ Ok</b> (and type the password)
                </li>
                <li>
                  KeePass writes a CSV with <code>Account, Login Name, Password, Web Site, Comments</code> headers which is supported by default.
                </li>
                <li>
                  In Fleet Commander, select  <b>Import CSV → Import your own... </b>
                </li>
              </ol>

              <p className="csvguide__tip">
                You should encrypt a CSV to not keep passwords in plaintext!
                <br/>
                Use the <b> ⚙ menu → Encrypt a CSV…</b> to keep an encrypted copy in your CSV
                folder. Remember the password!
              </p>
              
              <h4>Making your own CSV</h4>
              <p>
                Use these KeePass-style headers ideally (or change them in the <i>Column mapping &amp; options</i>):
              </p>
              <ul>
                <li>
                  <b>Web Site</b>: the SSH target: <code>ssh://root@host</code>, or just{' '}
                  <code>host</code> / <code>10.0.0.5</code>.
                </li>
                <li>
                  <b>Password</b>: the SSH password for that host.
                </li>
                <li>
                  <b>Login Name</b>: optional SSH user (tick “Use Login Name as the SSH user” under <i>Column mapping &amp; options</i>).
                </li>
              </ul>
              <p className="csvguide__tip">
                All additional column headers become variables accessible in your scripts! For example, <code>echo $Web_Site</code> can be used to print the SSH URL for each system.
              </p>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
