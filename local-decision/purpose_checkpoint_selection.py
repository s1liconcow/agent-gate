"""Prospective development criteria for the fixed disclosure operating point."""


def development_utility(summary, by_domain, domains):
    necessary = summary['necessary']
    negatives = summary['cases'] - necessary
    if necessary <= 0 or negatives <= 0 or not domains:
        raise ValueError('Both labels and declared workflows are required.')
    recall = summary['released_necessary'] / necessary
    false_rate = summary['false_releases'] / negatives
    domain_recall = {
        domain: by_domain[domain]['released_necessary'] / by_domain[domain]['necessary']
        if domain in by_domain and by_domain[domain]['necessary'] else 0.0
        for domain in domains
    }
    minimum = min(domain_recall.values())
    return {'passed': recall >= .95 and false_rate <= .01 and minimum >= .90,
            'necessary_recall': recall, 'false_release_rate': false_rate,
            'minimum_workflow_recall': minimum, 'by_domain_recall': domain_recall,
            'required_necessary_recall': .95, 'maximum_false_release_rate': .01,
            'required_minimum_workflow_recall': .90}


def checkpoint_key(utility, calibrated_loss):
    # Eligible candidates prioritize fewer false releases, then necessary recall.
    # A failed run retains its best calibrated loss for development diagnostics.
    if utility['passed']:
        return (0, utility['false_release_rate'], -utility['necessary_recall'], calibrated_loss)
    return (1, calibrated_loss, -utility['necessary_recall'], utility['false_release_rate'])
