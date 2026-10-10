# NAAC manual text (optional)

Put sections of the official NAAC manual here as Markdown files, one `## ` heading per
section. Start a heading with the metric ID when the section is about one metric, e.g.

    ## 3.3.1 Number of research papers published per teacher ...
    Text of the manual for this metric ...

`npm run seed` loads each section as a searchable "manual" article with the file name as the
citation. This file itself is skipped because it has no `## ` sections with content.
