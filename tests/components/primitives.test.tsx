/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Input';
import { Meter } from '@/components/ui/Meter';
import { Sparkline } from '@/components/ui/Sparkline';
import { Stat } from '@/components/ui/Stat';
import { StatusDot, STATUS_LABELS } from '@/components/ui/StatusDot';
import { Switch } from '@/components/ui/Switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';

afterEach(cleanup);

describe('Button', () => {
  it('renders its label and fires onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Probe now</Button>);

    fireEvent.click(screen.getByRole('button', { name: 'Probe now' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is disabled and announces itself busy while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );

    const button = screen.getByRole('button');
    // A loading button that stays clickable submits twice.
    expect(button).toBeDisabled();
    expect(button.getAttribute('aria-busy')).toBe('true');

    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps an accessible name when it is icon-only', () => {
    // An icon-only button with no label is invisible to a screen reader.
    render(<Button iconOnly aria-label="Delete connection" leadingIcon={<span>x</span>} />);
    expect(screen.getByRole('button', { name: 'Delete connection' })).toBeTruthy();
  });

  it('renders every variant without throwing', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'subtle'] as const) {
      cleanup();
      render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole('button', { name: variant })).toBeTruthy();
    }
  });
});

describe('Switch', () => {
  it('exposes itself as a switch with the right state', () => {
    render(<Switch checked onCheckedChange={() => {}} label="Enabled" />);

    const control = screen.getByRole('switch', { name: 'Enabled' });
    expect(control.getAttribute('aria-checked')).toBe('true');
  });

  it('reports the flipped value, not the current one', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="Enabled" />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} disabled onCheckedChange={onChange} label="Enabled" />);

    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('StatusDot', () => {
  it.each(['healthy', 'degraded', 'down', 'unconfigured', 'disabled'] as const)(
    'labels %s for a screen reader',
    (status) => {
      render(<StatusDot status={status} />);
      expect(screen.getByRole('img', { name: STATUS_LABELS[status] })).toBeTruthy();
    },
  );

  it('pulses for states that need attention, and rests otherwise', () => {
    // Twenty pulsing green dots would be noise; a failing provider should draw
    // the eye.
    const { container: healthy } = render(<StatusDot status="healthy" />);
    expect(healthy.querySelector('[data-live="false"]')).not.toBeNull();

    cleanup();

    const { container: down } = render(<StatusDot status="down" />);
    expect(down.querySelector('[data-live="true"]')).not.toBeNull();
  });

  it('can be forced to pulse', () => {
    const { container } = render(<StatusDot status="healthy" live />);
    expect(container.querySelector('[data-live="true"]')).not.toBeNull();
  });
});

describe('Field', () => {
  it('ties the label to the control it wraps', () => {
    render(<Field label="Monthly budget">{(id) => <Input id={id} />}</Field>);

    // Fails if the generated id is not threaded through — which is the whole
    // point of the render-prop signature.
    expect(screen.getByLabelText('Monthly budget')).toBeTruthy();
  });

  it('shows a hint when there is no error', () => {
    render(
      <Field label="Rate limit" hint="Blank means unlimited.">
        {(id) => <Input id={id} />}
      </Field>,
    );
    expect(screen.getByText('Blank means unlimited.')).toBeTruthy();
  });

  it('replaces the hint with the error, and announces it', () => {
    render(
      <Field label="Rate limit" hint="Blank means unlimited." error="Must be a whole number.">
        {(id) => <Input id={id} />}
      </Field>,
    );

    expect(screen.queryByText('Blank means unlimited.')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('Must be a whole number.');
  });

  it('marks a required field', () => {
    render(<Field label="API key" required>{(id) => <Input id={id} />}</Field>);
    expect(screen.getByText('*')).toBeTruthy();
  });
});

describe('Input, Textarea and Select', () => {
  it('reports typed values', () => {
    const onChange = vi.fn();
    render(<Input aria-label="Label" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Groq (personal)' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('flags an invalid input for assistive technology', () => {
    render(<Input aria-label="Port" invalid />);
    expect(screen.getByLabelText('Port').getAttribute('aria-invalid')).toBe('true');
  });

  it('does not set aria-invalid when the field is fine', () => {
    render(<Input aria-label="Port" />);
    expect(screen.getByLabelText('Port').getAttribute('aria-invalid')).toBeNull();
  });

  it('renders a textarea that accepts input', () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="Prompt" onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('renders select options and reports a choice', () => {
    const onChange = vi.fn();
    render(
      <Select aria-label="Strategy" defaultValue="free-first" onChange={onChange}>
        <option value="free-first">Free first</option>
        <option value="fastest">Fastest</option>
      </Select>,
    );

    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: 'fastest' } });
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Tabs', () => {
  const items = [
    { value: 'models', label: 'Models', count: 9 },
    { value: 'health', label: 'Health' },
    { value: 'usage', label: 'Usage' },
  ];

  it('marks only the active tab as selected', () => {
    render(<Tabs items={items} value="health" onChange={() => {}} />);

    expect(screen.getByRole('tab', { name: /Health/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Usage/ }).getAttribute('aria-selected')).toBe('false');
  });

  it('reports the tab that was clicked', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="models" onChange={onChange} />);

    fireEvent.click(screen.getByRole('tab', { name: /Usage/ }));
    expect(onChange).toHaveBeenCalledWith('usage');
  });

  it('moves with the arrow keys', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="models" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('health');
  });

  it('wraps around at the ends rather than dead-ending', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="models" onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('usage');
  });

  it('jumps to the ends with Home and End', () => {
    const onChange = vi.fn();
    render(<Tabs items={items} value="health" onChange={onChange} />);
    const list = screen.getByRole('tablist');

    fireEvent.keyDown(list, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('models');

    fireEvent.keyDown(list, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('usage');
  });

  it('keeps only the active tab in the tab order', () => {
    // Roving tabindex: one Tab press should enter the group, not walk it.
    render(<Tabs items={items} value="health" onChange={() => {}} />);

    expect(screen.getByRole('tab', { name: /Health/ }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: /Models/ }).getAttribute('tabindex')).toBe('-1');
  });
});

describe('Meter', () => {
  it('reports its value as a percentage of the limit', () => {
    render(<Meter value={25} limit={100} label="This month" />);

    const meter = screen.getByRole('meter', { name: 'This month' });
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
  });

  it('clamps a value over the limit to 100%', () => {
    render(<Meter value={500} limit={100} label="Overspent" />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
  });

  it('says so plainly when there is no limit', () => {
    render(<Meter value={12} limit={null} label="Spend" />);

    expect(screen.getByText('No limit set')).toBeTruthy();
    // Without a ceiling there is no meaningful progress to report.
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('formats currency when asked', () => {
    render(<Meter value={12.5} limit={100} label="Spend" currency />);
    expect(screen.getByText(/\$12\.50/)).toBeTruthy();
  });
});

describe('Table', () => {
  it('renders semantic rows and headers', () => {
    render(
      <Table>
        <THead>
          <TR>
            <TH>Provider</TH>
            <TH align="right">Spend</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>Groq</TD>
            <TD align="right">$0.12</TD>
          </TR>
        </TBody>
      </Table>,
    );

    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    const row = screen.getAllByRole('row')[1];
    expect(within(row!).getByText('Groq')).toBeTruthy();
  });

  it('scopes headers to their column for screen readers', () => {
    render(
      <Table>
        <THead>
          <TR>
            <TH>Model</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>x</TD>
          </TR>
        </TBody>
      </Table>,
    );

    expect(screen.getByRole('columnheader').getAttribute('scope')).toBe('col');
  });

  it('announces the sort direction of a sorted column', () => {
    render(
      <Table>
        <THead>
          <TR>
            <TH sortable sorted="desc">
              Cost
            </TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>x</TD>
          </TR>
        </TBody>
      </Table>,
    );

    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe('descending');
  });

  it('right-aligned numeric cells use tabular figures so they do not jitter', () => {
    const { container } = render(
      <Table>
        <TBody>
          <TR>
            <TD align="right">1,024</TD>
          </TR>
        </TBody>
      </Table>,
    );

    expect(container.querySelector('td')?.className).toContain('tabular');
  });
});

describe('Badge', () => {
  it('renders its content', () => {
    render(<Badge tone="ok">free</Badge>);
    expect(screen.getByText('free')).toBeTruthy();
  });

  it('hides the decorative dot from assistive technology', () => {
    const { container } = render(<Badge tone="down" dot>down</Badge>);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('Sparkline', () => {
  it('draws a path when it has a series', () => {
    const { container } = render(<Sparkline data={[1, 5, 2, 8, 3]} />);
    expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('degrades to a placeholder rather than crashing on too little data', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('path')).toHaveLength(0);
  });

  it('survives a flat series without dividing by zero', () => {
    const { container } = render(<Sparkline data={[4, 4, 4, 4]} />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
  });

  it('is hidden from screen readers, being purely decorative', () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Stat', () => {
  it('shows its label and value', () => {
    render(<Stat label="Requests" value="1,204" />);
    expect(screen.getByText('Requests')).toBeTruthy();
    expect(screen.getByText('1,204')).toBeTruthy();
  });

  it('renders a hint and a delta together', () => {
    render(
      <Stat
        label="Spend"
        value="$1.20"
        hint="vs. yesterday"
        delta={{ value: '12%', direction: 'up', good: false }}
      />,
    );

    expect(screen.getByText('vs. yesterday')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('renders the title, description and action', () => {
    render(
      <EmptyState
        title="No providers yet"
        description="Connect one to get started."
        action={<Button>Connect</Button>}
      />,
    );

    expect(screen.getByText('No providers yet')).toBeTruthy();
    expect(screen.getByText('Connect one to get started.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('works with only a title', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
